import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations } from '../src/db/migrations.js';
import { RunStore } from '../src/store.js';
import { ApprovalStore } from '../src/approvals.js';
import { tickExternal, reconcileExternal, fixtureEndpoint } from '../src/external.js';
const stores: RunStore[] = []; const servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const store of stores.splice(0)) store.db.close(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function setup(drop = true) {
  const applied = new Map<string, unknown>(); let posts = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET') { const item = applied.get(request.url!.split('/').at(-1)!); response.writeHead(item ? 200 : 404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(item ?? {})); return; }
    let body = ''; request.on('data', part => { body += String(part); }); request.on('end', () => { posts++; const value = JSON.parse(body) as { id: string; payloadHash: string }; const result = { id: value.id, payloadHash: value.payloadHash, result: { accepted: true } }; applied.set(value.id, result); if (drop) request.socket.destroy(); else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result)); } });
  }); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  vi.stubEnv('LOOMRAIL_ENABLE_HTTP_FIXTURE', 'true'); vi.stubEnv('LOOMRAIL_HTTP_FIXTURE_URL', `http://127.0.0.1:${port}/actions`);
  const db = openDatabase(':memory:'); applyMigrations(db); const store = new RunStore(db); stores.push(store);
  db.prepare('INSERT INTO records VALUES (?,1,?)').run('DEMO', JSON.stringify({ sku: 'DEMO', name: 'Fictional' }));
  const draft = store.createWorkflow({ name: 'Controlled HTTP fixture' }); const saved = store.saveDraft(draft.id, { schemaVersion: 1, name: draft.name, revision: 0, layout: {}, graph: { schemaVersion: 1, nodes: [{ id: 'start', name: 'Start', type: 'manual_trigger', config: {} }, { id: 'action', name: 'Reviewed fixture write', type: 'record_update', config: { proposal: { source: 'input', path: [] }, destination: 'http_fixture' } }, { id: 'out', name: 'Output', type: 'output', config: { fields: { result: { source: 'step', nodeId: 'action', path: [] } } } }], edges: [{ id: 'a', source: 'start', target: 'action', port: 'next' }, { id: 'b', source: 'action', target: 'out', port: 'next' }] } });
  const version = store.publish(draft.id, { revision: saved.revision }).version;
  const run = store.create({ workflowVersionId: version.id, requestId: randomUUID(), input: { sku: 'DEMO', expectedRevision: 1, changes: { name: 'Reviewed fictional update' } } });
  store.claim('w'); while (store.advance(run.id,'w')) { /* await review */ }
  const approvals = new ApprovalStore(store); const approval = approvals.list()[0]!; approvals.decide(approval.id, { decision: 'approve', revision: 1 }); store.claim('w'); store.advance(run.id,'w');
  return { store, run, approval, posts: () => posts };
}
describe('controlled external write uncertainty', () => {
  it('pauses after an applied write loses its response, then reconciles by identity without repeating POST', async () => {
    const { store, run, approval, posts } = await setup(); await tickExternal(store,run.id,'w');
    expect(store.get(run.id).status).toBe('needs_attention'); expect(store.steps(run.id).find(step => step.nodeId === 'action')!.status).toBe('uncertain'); expect(posts()).toBe(1);
    expect(store.claim('w')).toBeNull(); expect(await reconcileExternal(store,approval.id)).toEqual({ status: 'succeeded' });
    store.claim('w'); while (store.advance(run.id,'w')) { /* finish */ }
    expect(store.get(run.id).status).toBe('succeeded'); await reconcileExternal(store,approval.id); expect(posts()).toBe(1); expect(store.db.prepare('SELECT revision FROM records').get()!.revision).toBe(1);
  });
  it('marks a prepared in-flight action uncertain after restart without sending it again', async () => {
    const { store,run,approval,posts } = await setup(); store.release('w'); const replacement = new RunStore(store.db); replacement.claim('replacement'); replacement.advance(run.id,'replacement');
    expect(replacement.get(run.id).status).toBe('needs_attention'); expect((await reconcileExternal(replacement,approval.id)).status).toBe('uncertain'); expect(posts()).toBe(0);
  });
  it('confirms a normal response and continues the run', async () => { const { store,run,posts } = await setup(false); await tickExternal(store,run.id,'w'); store.claim('w'); store.advance(run.id,'w'); expect(store.get(run.id).status).toBe('succeeded'); expect(posts()).toBe(1); });
  it('rejects arbitrary destinations and requires a narrow opt-in', () => {
    for (const value of ['https://example.com/actions','http://localhost:3000/actions','http://127.0.0.1:3000/redirect','http://user:pass@127.0.0.1:3000/actions','http://127.0.0.1:3000/actions?redirect=x']) { vi.stubEnv('LOOMRAIL_ENABLE_HTTP_FIXTURE','true'); vi.stubEnv('LOOMRAIL_HTTP_FIXTURE_URL',value); expect(() => fixtureEndpoint()).toThrow(); }
    vi.stubEnv('LOOMRAIL_ENABLE_HTTP_FIXTURE','false'); expect(() => fixtureEndpoint()).toThrow('disabled');
  });
});
