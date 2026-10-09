import { afterEach, describe, expect, it } from 'vitest';
import { defaultAgent, type Provider } from '@loomrail/contracts';
import { FixtureProvider } from '@loomrail/providers';
import { AgentStore, tickAgent } from '../src/agents.js';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations } from '../src/db/migrations.js';
import { RunStore, LEASE_MS } from '../src/store.js';

const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });
function setup(now: () => number = Date.now) { const db = openDatabase(':memory:'); applyMigrations(db); const store = new RunStore(db, now); stores.push(store); return { store, agents: new AgentStore(store) }; }
async function drain(store: RunStore, id: string, token = 'worker') {
  for (let count = 0; count < 30 && ['queued', 'running'].includes(store.get(id).status); count++) { store.claim(token); if (store.advance(id, token)) await tickAgent(store, id, token); }
  return store.get(id);
}
describe('durable bounded agents', () => {
  it('executes read-only tools, saves unknown usage and immutable definition, then validates output', async () => {
    const { store, agents } = setup(); const agent = agents.publish(defaultAgent);
    store.db.prepare('INSERT INTO records VALUES (?,1,?)').run('DEMO-001', JSON.stringify({ sku: 'DEMO-001', name: 'Saved tote', price: 24 }));
    const run = agents.testRun(agent.id, { sku: 'DEMO-001' });
    agents.publish({ ...defaultAgent, model: { provider: 'fixture', model: 'malformed-v1', mode: 'fixture' } }, agent.agentId);
    expect((await drain(store, run.id)).result).toMatchObject({ listing: { title: 'Saved tote' } });
    const state = store.detail(run.id).agents[0]!;
    expect(state.agent.id).toBe(agent.id); expect(state.tools).toHaveLength(2); expect(state.responses).toHaveLength(2);
    expect(state.responses[0]!.usage.estimatedCostUsd).toBeNull();
    expect(() => store.db.prepare("UPDATE agent_versions SET data_json='{}'").run()).toThrow('immutable');
  });
  it.each([['malformed-v1','INVALID_OUTPUT'], ['unavailable-v1','PROVIDER_UNAVAILABLE'], ['quota-v1','QUOTA_EXCEEDED'], ['unauthorized-v1','TOOL_NOT_ALLOWED'], ['limit-v1','LIMIT_EXCEEDED'], ['loop-v1','LIMIT_EXCEEDED'], ['timeout-v1','TIMEOUT']])('fails safely for %s', async (model, code) => {
    const { store, agents } = setup(); const agent = agents.publish({ ...defaultAgent, model: { provider: 'fixture', model, mode: 'fixture' }, limits: { ...defaultAgent.limits, timeoutMs: model === 'timeout-v1' ? 20 : 10000 } });
    const run = agents.testRun(agent.id, { sku: 'DEMO-001' }); const result = await drain(store, run.id);
    expect(result.status).toBe('failed'); expect(result.error?.code).toBe(code);
    expect(store.steps(run.id).find(step => step.nodeId === 'output')?.status).toBe('skipped');
  });
  it('resumes persisted tool results after worker replacement without repeating the first model round', async () => {
    let now = Date.now(); const { store, agents } = setup(() => now); const agent = agents.publish(defaultAgent);
    const run = agents.testRun(agent.id, { sku: 'DEMO-001' }); store.claim('old'); store.advance(run.id, 'old'); store.advance(run.id, 'old'); await tickAgent(store, run.id, 'old');
    expect(store.detail(run.id).agents[0]!.tools).toHaveLength(2);
    now += LEASE_MS + 1; expect(store.claim('new')).toBe(run.id);
    expect((await drain(store, run.id, 'new')).status).toBe('succeeded');
    expect(store.detail(run.id).agents[0]!.requests).toBe(2);
  });
  it('preserves response checkpoint if interrupted before tools and consumes it without another request', async () => {
    const { store, agents } = setup(); const agent = agents.publish(defaultAgent); const run = agents.testRun(agent.id, { sku: 'DEMO-001' });
    store.claim('w'); store.advance(run.id, 'w'); store.advance(run.id, 'w');
    const work = store.agentWork(run.id, 'w')!;
    const response = await new FixtureProvider().generate({ schemaVersion: 1, model: defaultAgent.model, messages: work.state.messages, tools: [], settings: defaultAgent.settings, limits: { maxInputBytes: 50000, maxToolCalls: 6, timeoutMs: 1000 } });
    work.state.pendingResponse = response; work.state.responses.push(response); work.state.requests = 1;
    store.checkpointAgent(run.id, work.nodeId, 'w', work.state, 'model_responded');
    await tickAgent(store, run.id, 'w', new Map());
    expect(store.agentWork(run.id, 'w')!.state.tools).toHaveLength(2);
  });
  it('cancels active requests and rejects late writes after cancellation', async () => {
    const { store, agents } = setup(); const agent = agents.publish(defaultAgent); const run = agents.testRun(agent.id, { sku: 'DEMO-001' });
    store.claim('w'); store.advance(run.id, 'w'); store.advance(run.id, 'w');
    let aborted = false;
    const provider: Provider = { id: 'fixture', capabilities: new FixtureProvider().capabilities, generate: async (_request, signal) => { store.cancel(run.id); return await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })); } };
    await expect(tickAgent(store, run.id, 'w', new Map([['fixture', provider]]))).rejects.toThrow('no longer owned');
    expect(aborted).toBe(true); expect(store.get(run.id).status).toBe('cancelled'); expect(store.steps(run.id).find(step => step.nodeId === 'agent')?.status).toBe('cancelled');
  });
  it('rejects unsafe schemas and missing pinned source versions', () => {
    const { agents } = setup(); expect(() => agents.publish({ ...defaultAgent, outputSchema: { $ref: 'file:///etc/passwd' } })).toThrow('unsupported');
    expect(() => agents.publish({ ...defaultAgent, knowledgeVersionIds: ['missing'] })).toThrow('missing');
  });
});
