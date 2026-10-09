import { createHash } from 'node:crypto';
import type { Approval, JsonValue } from '@loomrail/contracts';
import { StoreError, type RunStore } from './store.js';

export function fixtureEndpoint(): string {
  if (process.env.LOOMRAIL_ENABLE_HTTP_FIXTURE !== 'true') throw new StoreError(400, 'Controlled HTTP fixture actions are disabled.');
  let url: URL;
  try { url = new URL(process.env.LOOMRAIL_HTTP_FIXTURE_URL ?? ''); } catch { throw new StoreError(400, 'Configure the controlled loopback fixture URL.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/actions' || url.search || url.hash) throw new StoreError(400, 'Fixture URL must be http://127.0.0.1:<port>/actions with no credentials, query, or fragment.');
  return url.href;
}
export interface ExternalAttempt { approval: Approval; endpoint: string; payloadHash: string; result: JsonValue | null; }
export function prepareExternal(store: RunStore, approval: Approval): ExternalAttempt {
  if (approval.status !== 'approved') throw new StoreError(409, 'Exact proposal must be approved before dispatch.');
  const endpoint = fixtureEndpoint();
  if (approval.destination !== endpoint) throw new StoreError(409, 'The approved fixture destination changed. Create a new proposal.');
  const attempt: ExternalAttempt = { approval, endpoint, payloadHash: createHash('sha256').update(JSON.stringify(approval.payload)).digest('hex'), result: null };
  store.db.prepare('INSERT INTO actions VALUES (?,?,?,?,?)').run(approval.id, approval.runId, 'http_fixture', 'sending', JSON.stringify(attempt));
  return attempt;
}
async function fixtureRequest(attempt: ExternalAttempt, method: 'GET' | 'POST', signal?: AbortSignal): Promise<JsonValue> {
  if (fixtureEndpoint() !== attempt.endpoint) throw new StoreError(409, 'Configured fixture endpoint does not match this action.');
  const url = method === 'POST' ? attempt.endpoint : `${attempt.endpoint}/${attempt.approval.id}`;
  const response = await fetch(url, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.approval.id }, ...(method === 'POST' ? { body: JSON.stringify({ id: attempt.approval.id, payloadHash: attempt.payloadHash, payload: attempt.approval.payload }) } : {}) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('No confirmed result'); }
  const reader = response.body!.getReader(); let size = 0; const parts: Uint8Array[] = [];
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 100000) { await reader.cancel(); throw new Error('Result too large'); } parts.push(part.value); } } finally { reader.releaseLock(); }
  const result = JSON.parse(Buffer.concat(parts).toString()) as { id?: string; payloadHash?: string; result?: JsonValue };
  if (result.id !== attempt.approval.id || result.payloadHash !== attempt.payloadHash || result.result === undefined) throw new Error('Result identity mismatch');
  return result.result;
}
export async function tickExternal(store: RunStore, runId: string, token: string, shutdown?: AbortSignal) {
  const row = store.db.prepare("SELECT * FROM actions WHERE run_id=? AND kind='http_fixture' AND status='sending'").get(runId);
  if (!row) return;
  const attempt = JSON.parse(String(row.data_json)) as ExternalAttempt;
  const abort = new AbortController(); const signal = shutdown ? AbortSignal.any([abort.signal, shutdown]) : abort.signal;
  const timer = setInterval(() => { try { store.heartbeat(runId, token); } catch { abort.abort(); } }, 250);
  try { const result = await fixtureRequest(attempt, 'POST', signal); store.externalOutcome(String(row.id), result); }
  catch { store.externalOutcome(String(row.id), null); }
  finally { clearInterval(timer); }
}
export async function reconcileExternal(store: RunStore, id: string) {
  const row = store.db.prepare("SELECT * FROM actions WHERE id=? AND kind='http_fixture'").get(id);
  if (!row) throw new StoreError(404, 'Controlled external action not found.');
  if (row.status === 'succeeded') return { status: 'succeeded' };
  if (row.status !== 'uncertain') throw new StoreError(409, 'Action is still in flight.');
  try { const result = await fixtureRequest(JSON.parse(String(row.data_json)) as ExternalAttempt, 'GET'); store.externalOutcome(id, result); return { status: 'succeeded' }; }
  catch { return { status: 'uncertain', message: 'No matching confirmed result. The write was not retried. Inspect the fixture service or cancel the run.' }; }
}
