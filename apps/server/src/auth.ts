import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Binding, WorkflowGraph } from '@loomrail/contracts';

const SESSION_MS = 12 * 60 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

export class OperatorAuth {
  private attempts = 0;
  private attemptWindow = 0;
  constructor(private db: DatabaseSync, private secret: string, readonly origin: string, private now: () => number = Date.now) {
    const url = new URL(origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('LOOMRAIL_ORIGIN must be an exact loopback HTTP(S) origin.');
    if (secret.length < 32) throw new Error('Operator secret must be at least 32 characters.');
  }
  allowedRequest(request: FastifyRequest) {
    const origin = request.headers.origin;
    if (origin && origin !== this.origin) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin !== this.origin) return false;
    return true;
  }
  private cookie(value: string, maxAge: number) {
    return `loomrail_session=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  private token(request: FastifyRequest) {
    const matches = (request.headers.cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith('loomrail_session='));
    if (matches.length !== 1) return null;
    const value = matches[0]!.slice('loomrail_session='.length);
    if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const [nonce, signature] = value.split('.');
    return equal(signature!, createHmac('sha256', this.secret).update(`session:${nonce!}`).digest('base64url')) ? value : null;
  }
  csrf(token: string) { return createHmac('sha256', this.secret).update(`csrf:${token}`).digest('base64url'); }
  session(request: FastifyRequest) {
    const token = this.token(request);
    if (!token) return null;
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash(token));
    return row && Number(row.expires_at) > this.now() ? { token, csrfToken: this.csrf(token) } : null;
  }
  checkCsrf(request: FastifyRequest, token: string) {
    const supplied = request.headers['x-csrf-token'];
    return typeof supplied === 'string' && equal(supplied, this.csrf(token));
  }
  login(request: FastifyRequest, reply: FastifyReply) {
    if (this.now() - this.attemptWindow >= 60_000) { this.attemptWindow = this.now(); this.attempts = 0; }
    if (++this.attempts > 10) return reply.code(429).header('Retry-After', '60').send({ error: 'Too many sign-in attempts. Try again in one minute.' });
    const body = request.body as { secret?: unknown } | undefined;
    if (!body || typeof body.secret !== 'string' || body.secret.length > 256 || !equal(body.secret, this.secret)) return reply.code(401).send({ error: 'Operator key was not accepted.' });
    this.attempts = 0;
    const previous = this.token(request);
    if (previous) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(previous));
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
    const nonce = randomBytes(32).toString('base64url');
    const token = `${nonce}.${createHmac('sha256', this.secret).update(`session:${nonce}`).digest('base64url')}`;
    this.db.prepare('INSERT INTO sessions VALUES (?, ?)').run(hash(token), this.now() + SESSION_MS);
    return reply.header('Set-Cookie', this.cookie(token, SESSION_MS / 1000)).send({ csrfToken: this.csrf(token) });
  }
  logout(request: FastifyRequest, reply: FastifyReply) {
    const token = this.token(request);
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
    return reply.header('Set-Cookie', this.cookie('', 0)).send({ ok: true });
  }
}

/** Trace/API projection only; internal deterministic evaluation retains the original values. */
export function redact(value: unknown, secrets: string[] = [], fields = true): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => secret ? text.replaceAll(secret, '[redacted]') : text, value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets, fields));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fields && !['inputTokens', 'outputTokens', 'maxOutputTokens'].includes(key) && /password|secret|authorization|cookie|token|api.?key/i.test(key) ? '[redacted]' : redact(item, secrets, fields)]));
  return value;
}

/** Preserve executable schema structure while redacting literal record data. */
export function redactGraph(graph: WorkflowGraph, secrets: string[]): WorkflowGraph {
  const result = redact(graph, secrets, false) as WorkflowGraph;
  const binding = (value: Binding, key = '') => {
    if (value.source === 'literal') value.value = /password|secret|authorization|cookie|token|api.?key/i.test(key) ? '[redacted]' : redact(value.value, secrets) as typeof value.value;
  };
  for (const node of result.nodes) {
    if (node.type === 'mapping' || node.type === 'output') for (const [key, value] of Object.entries(node.config.fields)) binding(value, key);
    if (node.type === 'record_update') binding(node.config.proposal);
    if (node.type === 'agent') binding(node.config.input);
    if (node.type === 'condition') { binding(node.config.left); if (node.config.operator !== 'exists') binding(node.config.right); }
  }
  return result;
}
