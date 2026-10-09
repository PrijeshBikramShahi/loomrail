import { EvaluationStore, catalogueCases } from './evaluations.js';
import { reconcileExternal } from './external.js';
import { DataStore } from './data.js';
import { ApprovalStore } from './approvals.js';
import { AgentStore, providerStatus } from './agents.js';
import { LoomrailError } from '@loomrail/contracts';
import Fastify from 'fastify';
import { OperatorAuth, redact, redactGraph } from './auth.js';
import { StoreError, type RunStore } from './store.js';

export function buildApp(options?: { store: RunStore; operatorSecret: string; origin: string; apiPort?: number }) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_000_000,
    requestTimeout: 10_000,
  });
  app.get('/health', async () => ({ status: 'ok', service: 'loomrail', schemaVersion: 1 }));
  if (!options) return app;
  const { store, operatorSecret, origin } = options;
  const agents = new AgentStore(store);
  const secrets = [operatorSecret, process.env.OPENAI_API_KEY ?? '', process.env.OPENROUTER_API_KEY ?? ''];
  const auth = new OperatorAuth(store.db, operatorSecret, origin, store.now);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (!request.url.startsWith('/api/')) return;
    const allowedHosts = [new URL(origin).host, `127.0.0.1:${options.apiPort ?? 3001}`];
    if (!allowedHosts.includes(request.headers.host ?? '') || !auth.allowedRequest(request)) return reply.code(403).send({ error: 'Request origin is not allowed.' });
    if (request.url === '/api/session' && request.method === 'POST') return;
    const session = auth.session(request);
    if (!session) return reply.code(401).send({ error: 'Sign in with your operator key.' });
    if (!['GET', 'HEAD'].includes(request.method) && !auth.checkCsrf(request, session.token)) return reply.code(403).send({ error: 'Session protection failed. Refresh and try again.' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof LoomrailError) return reply.code(400).send({ error: error.details.message, code: error.details.code });
    if (error instanceof StoreError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof Error && error.name === 'ZodError') return reply.code(400).send({ error: 'Request does not match the required input contract.' });
    const code = (error as { statusCode?: number }).statusCode;
    return reply.code(code && code >= 400 && code < 500 ? code : 500).send({ error: code === 413 ? 'Request is too large.' : 'Request could not be processed.' });
  });
  app.post('/api/session', (request, reply) => auth.login(request, reply));
  app.get('/api/session', request => ({ csrfToken: auth.session(request)!.csrfToken }));
  app.delete('/api/session', (request, reply) => auth.logout(request, reply));
  app.get('/api/workflows', () => store.workflows());
  app.post('/api/workflows', (request, reply) => reply.code(201).send(store.createWorkflow(request.body)));
  // Drafts are editable definitions, not trace payloads: preserve structural field names.
  app.get<{ Params: { id: string } }>('/api/workflows/:id', request => redact(store.workflow(request.params.id), secrets, false));
  app.put<{ Params: { id: string } }>('/api/workflows/:id/draft', request => redact(store.saveDraft(request.params.id, request.body), secrets, false));
  app.post<{ Params: { id: string } }>('/api/workflows/:id/publish', request => redact(store.publish(request.params.id, request.body), secrets, false));
  app.get('/api/runs', () => redact(store.list().map(run => ({ ...run, input: {}, result: null })), secrets));
  app.post('/api/runs', (request, reply) => reply.code(201).send(redact(store.create(request.body), secrets)));
  app.get<{ Params: { id: string } }>('/api/runs/:id', request => {
    const detail = store.detail(request.params.id);
    return { ...redact(detail, secrets) as Record<string, unknown>, graph: redactGraph(detail.graph, secrets) };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/runs/:id/events', request => {
    const after = Number(request.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new StoreError(400, 'after must be a nonnegative integer.');
    return store.events(request.params.id, after);
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', request => redact(store.cancel(request.params.id), secrets));
  const evaluations = new EvaluationStore(store);
  app.get('/api/evaluations/cases', () => redact(evaluations.cases(), secrets, false));
  app.post('/api/evaluations/cases', request => redact(evaluations.saveCase(request.body), secrets, false));
  app.post('/api/evaluations/catalogue-cases', () => { const existing = new Set(evaluations.cases().map(item => item.definition.name)); return catalogueCases().filter(item => !existing.has(item.name)).map(item => evaluations.saveCase(item)); });
  app.get('/api/evaluations/versions', () => evaluations.versions());
  app.get('/api/evaluations', () => redact(evaluations.list(), secrets));
  app.post('/api/evaluations', async request => redact(await evaluations.run(request.body), secrets));
  const data = new DataStore(store);
  app.get('/api/records', () => redact(data.records(), secrets));
  app.get<{ Params: { sku: string } }>('/api/records/:sku', request => redact(data.record(request.params.sku), secrets));
  app.post('/api/records/preview', request => redact(data.parseCsv(request.body), secrets));
  app.post('/api/records/import', request => redact(data.importCsv(request.body), secrets));
  app.get('/api/knowledge', () => data.sources());
  app.get<{ Params: { id: string } }>('/api/knowledge/:id', request => redact(data.source(request.params.id), secrets));
  app.post('/api/knowledge', request => redact(data.importSource(request.body), secrets));
  app.post('/api/knowledge/search', request => redact(data.search(request.body), secrets));
  app.post('/api/catalogue/starter', () => redact(data.createCatalogue(), secrets, false));
  app.post<{ Params: { id: string } }>('/api/actions/:id/reconcile', request => reconcileExternal(store, request.params.id));
  app.get('/api/approvals', () => redact(new ApprovalStore(store).list(), secrets));
  app.post<{ Params: { id: string } }>('/api/approvals/:id/decide', request => redact(new ApprovalStore(store).decide(request.params.id, request.body), secrets));
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', (request, reply) => {
    const row = store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(request.params.id);
    if (!row) throw new StoreError(404, 'Artifact not found.');
    return reply.header('Content-Disposition', `attachment; filename="listing.json"`).send(redact(JSON.parse(String(row.data_json)), secrets));
  });
  app.get('/api/agents', () => redact(agents.list(), secrets, false));
  app.post('/api/agents', request => redact(agents.publish(request.body), secrets, false));
  app.post<{ Params: { id: string } }>('/api/agents/:id/versions', request => redact(agents.publish(request.body, request.params.id), secrets, false));
  app.post<{ Params: { id: string } }>('/api/agents/:id/test', request => redact(agents.testRun(request.params.id, request.body), secrets));
  app.get('/api/settings/providers', () => providerStatus());
  return app;
}
