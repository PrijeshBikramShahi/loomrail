import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { sampleCatalogueInput } from '@loomrail/contracts';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations } from '../src/db/migrations.js';
import { RunStore } from '../src/store.js';
import { buildApp } from '../src/app.js';

const origin = 'http://127.0.0.1:5173';
const host = '127.0.0.1:3001';
const secret = 'test-only-operator-key-with-at-least-32-characters';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
function setup() {
  let now = Date.now(); const db = openDatabase(':memory:'); applyMigrations(db);
  const store = new RunStore(db, () => now); store.seedSample();
  const app = buildApp({ store, operatorSecret: secret, origin });
  cleanups.push(async () => { await app.close(); db.close(); });
  return { app, store, expire: () => { now += 13 * 60 * 60 * 1000; } };
}
async function login(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({ method: 'POST', url: '/api/session', headers: { host, origin }, payload: { secret } });
  expect(response.statusCode).toBe(200);
  return { host, origin, cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json<{ csrfToken: string }>().csrfToken };
}

it('requires authentication for workflows, history, run details and commands', async () => {
  const { app } = setup();
  for (const url of ['/api/workflows', '/api/runs', '/api/runs/missing', '/api/runs/missing/events', '/api/agents', '/api/records', '/api/knowledge', '/api/approvals', '/api/evaluations', '/api/evaluations/cases', '/api/settings/providers']) expect((await app.inject({ url, headers: { host } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/runs', headers: { host, origin }, payload: {} })).statusCode).toBe(401);
});
it('blocks cross-origin login, missing origin, and untrusted hosts', async () => {
  const { app } = setup();
  for (const headers of [{ host, origin: 'https://evil.example' }, { host }, { host: 'evil.example', origin }]) {
    expect((await app.inject({ method: 'POST', url: '/api/session', headers, payload: { secret } })).statusCode).toBe(403);
  }
});
it('sets a private session cookie, rejects CSRF, and revokes logout sessions', async () => {
  const { app } = setup(); const headers = await login(app);
  expect((await app.inject({ url: '/api/session', headers })).json()).toHaveProperty('csrfToken');
  const missingCsrf = { ...headers, 'x-csrf-token': '' };
  expect((await app.inject({ method: 'POST', url: '/api/runs', headers: missingCsrf, payload: {} })).statusCode).toBe(403);
  const logout = await app.inject({ method: 'DELETE', url: '/api/session', headers });
  expect(logout.statusCode).toBe(200); expect(logout.headers['set-cookie']).toContain('HttpOnly'); expect(logout.headers['set-cookie']).toContain('SameSite=Strict');
  expect((await app.inject({ url: '/api/runs', headers })).statusCode).toBe(401);
});
it('expires sessions and stores only hashes rather than cookie credentials', async () => {
  const { app, store, expire } = setup(); const headers = await login(app);
  expect(JSON.stringify(store.db.prepare('SELECT * FROM sessions').all())).not.toContain(headers.cookie.split('=')[1]);
  expire(); expect((await app.inject({ url: '/api/session', headers })).statusCode).toBe(401);
});
it('retains sessions after API restart with the same key and invalidates them after key rotation', async () => {
  const { app, store } = setup(); const headers = await login(app);
  const restarted = buildApp({ store, operatorSecret: secret, origin });
  const rotated = buildApp({ store, operatorSecret: `${secret}-rotated`, origin });
  try {
    expect((await restarted.inject({ url: '/api/session', headers })).statusCode).toBe(200);
    expect((await rotated.inject({ url: '/api/session', headers })).statusCode).toBe(401);
  } finally { await restarted.close(); await rotated.close(); }
});
it('creates, executes, inspects and replays events through the authenticated API', async () => {
  const { app, store } = setup(); const headers = await login(app);
  const response = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: { workflowVersionId: 'catalogue-v1', requestId: randomUUID(), input: sampleCatalogueInput } });
  expect(response.statusCode).toBe(201); const id = response.json<{ id: string }>().id;
  store.claim('worker'); while (store.advance(id, 'worker')) { /* bounded deterministic graph */ }
  const detail = await app.inject({ url: `/api/runs/${id}`, headers });
  expect(detail.json()).toMatchObject({ run: { status: 'succeeded' } });
  const replay = await app.inject({ url: `/api/runs/${id}/events?after=3`, headers });
  expect(replay.json<Array<{ sequence: number }>>()[0]?.sequence).toBe(4);
  expect((await app.inject({ url: `/api/runs/${id}/events?after=-1`, headers })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/runs/missing', headers })).statusCode).toBe(404);
});
it('redacts sensitive input fields and operator key values from run inspection', async () => {
  vi.stubEnv('OPENROUTER_API_KEY', 'private-openrouter-test-credential');
  const { app, store } = setup(); const headers = await login(app);
  const run = store.create({ workflowVersionId: 'catalogue-v1', requestId: randomUUID(), input: { ...sampleCatalogueInput, nested: { apiKey: 'private-value' }, note: secret, providerNote: 'private-openrouter-test-credential' } });
  const response = await app.inject({ url: `/api/runs/${run.id}`, headers });
  expect(response.body).not.toContain('private-value'); expect(response.body).not.toContain(secret); expect(response.body).toContain('[redacted]');
  expect(response.body).not.toContain('private-openrouter-test-credential');
  expect(JSON.stringify(store.events(run.id))).not.toContain('private-value');
});
it('rate limits wrong operator keys and does not reflect submitted secrets', async () => {
  const { app } = setup();
  for (let i = 0; i < 10; i++) {
    const result = await app.inject({ method: 'POST', url: '/api/session', headers: { host, origin }, payload: { secret: 'wrong-private-value' } });
    expect(result.statusCode).toBe(401); expect(result.body).not.toContain('wrong-private-value');
  }
  expect((await app.inject({ method: 'POST', url: '/api/session', headers: { host, origin }, payload: { secret } })).statusCode).toBe(429);
});
it('cancels queued runs idempotently and validates request bodies', async () => {
  const { app, store } = setup(); const headers = await login(app);
  expect((await app.inject({ method: 'POST', url: '/api/runs', headers, payload: {} })).statusCode).toBe(400);
  const run = store.create({ workflowVersionId: 'catalogue-v1', requestId: randomUUID(), input: {} });
  for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel`, headers })).json()).toMatchObject({ status: 'cancelled' });
  expect(store.events(run.id).filter(event => event.type === 'run_cancelled')).toHaveLength(1);
});

it('keeps every catalogue command behind authentication and CSRF, then returns a reviewed artifact', async () => {
  const { app, store } = setup(); const headers = await login(app);
  const csv = { csv: 'sku,name,price\nAPI-DEMO,Fictional API cup,12' };
  expect((await app.inject({ method:'POST',url:'/api/records/import',headers:{...headers,'x-csrf-token':''},payload:csv })).statusCode).toBe(403);
  expect((await app.inject({ method:'POST',url:'/api/records/import',headers,payload:csv })).statusCode).toBe(200);
  const source = await app.inject({method:'POST',url:'/api/knowledge',headers,payload:{name:'API fixture guide',text:'Listing guidelines: use verified facts.'}}); expect(source.statusCode).toBe(200);
  const starter=await app.inject({method:'POST',url:'/api/catalogue/starter',headers,payload:{}}); expect(starter.statusCode).toBe(200);
  const runResponse=await app.inject({method:'POST',url:'/api/runs',headers,payload:{workflowVersionId:starter.json().version.id,requestId:randomUUID(),input:{record:{sku:'API-DEMO',name:'Fictional API cup',price:12},revision:1}}}); const id=runResponse.json().id;
  const {tickAgent}=await import('../src/agents.js');
  for(let count=0;count<20&&['queued','running'].includes(store.get(id).status);count++){store.claim('api-test');if(store.advance(id,'api-test'))await tickAgent(store,id,'api-test');}
  const approvals=await app.inject({url:'/api/approvals',headers}); const approval=approvals.json()[0]; expect(approval.status).toBe('pending');
  expect((await app.inject({method:'POST',url:`/api/approvals/${approval.id}/decide`,headers,payload:{revision:1,decision:'approve'}})).statusCode).toBe(200);
  store.claim('api-test');while(store.advance(id,'api-test')){/* finish */}
  const artifact=await app.inject({url:`/api/artifacts/${approval.id}`,headers});expect(artifact.statusCode).toBe(200);expect(artifact.headers['content-disposition']).toContain('attachment');expect(artifact.json()).toMatchObject({sku:'API-DEMO',title:'Fictional API cup'});
});
