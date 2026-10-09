import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../apps/server/src/db/database.js';
import { applyMigrations } from '../apps/server/src/db/migrations.js';
import { RunStore } from '../apps/server/src/store.js';
import { DataStore } from '../apps/server/src/data.js';
import { AgentStore, tickAgent } from '../apps/server/src/agents.js';
import { ApprovalStore } from '../apps/server/src/approvals.js';
import { LAGUNA_FREE_MODEL, OpenRouterProvider } from '@loomrail/providers';
import { LoomrailError, openRouterModels } from '@loomrail/contracts';

// Deliberate live inference only. Never opens operator storage or auto-approves a proposal.
if (process.env.LOOMRAIL_REMOTE_ENABLED !== 'true' || !process.env.OPENROUTER_API_KEY) throw new Error('Set LOOMRAIL_REMOTE_ENABLED=true and OPENROUTER_API_KEY on this process.');
const selectedModel = openRouterModels.find(model => model.id === (process.argv.find(arg => arg.startsWith('--model='))?.slice(8) ?? LAGUNA_FREE_MODEL));
if (!selectedModel) throw new Error('Select an explicitly supported free model with --model=<id>.');
const outputMode = selectedModel.outputMode;
const db = openDatabase(':memory:'); applyMigrations(db); const store = new RunStore(db);
const paced = process.argv.includes('--paced');
let lastRequest = paced ? Date.now() : 0;
const transport: typeof fetch = async (url, options) => {
  const waitMs = paced ? Math.max(0, 65000 - (Date.now() - lastRequest)) : 0;
  if (waitMs) { console.log('Spacing free-provider calls before the next model request.'); await delay(waitMs, undefined, { signal: options?.signal ?? undefined }); }
  lastRequest = Date.now();
  const response = await fetch(url, options);
  if (!response.ok) console.log(JSON.stringify({ providerHttpStatus: response.status, rateLimits: Object.fromEntries(['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'].map(name => [name, response.headers.get(name)])) }));
  return response;
};
const provider = new OpenRouterProvider({ enabled: true, apiKey: process.env.OPENROUTER_API_KEY, fetcher: transport });
const model = { provider: 'openrouter', model: selectedModel.id, mode: 'remote' as const };
const catalogueOnly = process.argv.includes('--catalogue-only');
const report: Record<string, unknown> = { capturedAt: new Date().toISOString(), requestedModel: model, outputMode, paced, data: 'Fictional input only; isolated in-memory database; no external actions; no automatic approval.', humanQualityReview: 'Pending. Deterministic checks do not establish semantic quality.' };
try {
  if (!catalogueOnly) try {
    report.structuredSmoke = await provider.generate({ schemaVersion: 1, model, outputMode, messages: [{ role: 'user', content: 'Return {"ok":true,"name":"Fictional canvas tote","price":24} exactly as a JSON object.' }], tools: [], outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, name: { type: 'string' }, price: { type: 'number' } }, required: ['ok','name','price'], additionalProperties: false }, settings: { temperature: 0, maxOutputTokens: 2048 }, limits: { maxInputBytes: 10000, maxToolCalls: 0, timeoutMs: paced ? 90000 : 60000 } });
    console.log('Live JSON smoke passed. Starting catalogue tool workflow.');
  } catch (error) {
    report.structuredError = error instanceof LoomrailError ? error.details : { message: 'Unexpected smoke failure' };
    console.log(JSON.stringify({ structuredError: report.structuredError })); process.exitCode = 1;
  }
  if (!report.structuredError) {
    const data = new DataStore(store);
    data.importCsv({ csv: 'sku,name,price,material\nLAGUNA-001,Fictional ceramic cup,,ceramic' });
    data.importSource({ name: 'Fictional listing guidelines', text: 'Catalogue listing guidelines: use only verified record facts. Missing prices stay null and must be flagged missing_price. Never invent dimensions, capacity, certifications, or origin. Cite this source using its exact retrieved chunk ID. A concise title and description should state the known material.' });
    const starter = data.createCatalogue(); const graph = structuredClone(starter.version.graph); const node = graph.nodes.find(node => node.type === 'agent')!;
    const agents = new AgentStore(store); const original = agents.get(node.config.agentVersionId);
    const agent = agents.publish({ ...original.definition, name: `${selectedModel.label} live smoke`, model, outputMode, instructions: `${original.definition.instructions} Always call record_lookup for the supplied SKU and guideline_search with query "listing guidelines" before drafting. If price is absent, retain null and add missing_price to flags. Return the final listing JSON only.`, settings: { temperature: 0, maxOutputTokens: 4096 }, limits: { ...original.definition.limits, maxIterations: 4, timeoutMs: 180000 } });
    node.config.agentVersionId = agent.id;
    const draft = store.workflow(starter.workflow.id); const saved = store.saveDraft(draft.id, { schemaVersion: 1, name: draft.name, layout: draft.layout, revision: draft.revision, graph });
    const version = store.publish(draft.id, { revision: saved.revision }).version;
    const record = data.record('LAGUNA-001'); const run = store.create({ workflowVersionId: version.id, requestId: randomUUID(), input: { record: record.data, revision: record.revision } });
    for (let i = 0; i < 30 && ['queued','running'].includes(store.get(run.id).status); i++) {
      store.claim('live-smoke'); if (store.advance(run.id, 'live-smoke')) await tickAgent(store, run.id, 'live-smoke', new Map([['openrouter', provider]]));
    }
    const detail = store.detail(run.id); const approval = new ApprovalStore(store).forStep(run.id, 'review');
    const state = detail.agents[0];
    const checks = { pausedForApproval: detail.run.status === 'awaiting_approval', recordLookup: state?.tools.some(tool => tool.name === 'record_lookup') ?? false, guidelineSearch: state?.tools.some(tool => tool.name === 'guideline_search') ?? false, missingPricePreserved: approval?.payload.changes.price === null, missingPriceFlagged: Array.isArray(approval?.payload.changes.flags) && approval.payload.changes.flags.includes('missing_price'), citationsPresent: Array.isArray(approval?.payload.changes.sourceReferences) && approval.payload.changes.sourceReferences.length > 0, noRecordChange: data.record('LAGUNA-001').revision === 1 };
    report.catalogue = { agent, detail, approval, checks, passed: Object.values(checks).every(Boolean) };
    console.log(JSON.stringify({ runId: run.id, status: detail.run.status, checks, error: detail.run.error }, null, 2));
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  }
} finally {
  // The normalized provider response excludes reasoning. Redact the configured credential defensively.
  const serialized = JSON.stringify(report, null, 2).split(process.env.OPENROUTER_API_KEY).join('[REDACTED]');
  const prefix = selectedModel.id === LAGUNA_FREE_MODEL ? 'laguna-s' : 'nemotron-super';
  writeFileSync(`docs/validation/${prefix}-${paced ? 'paced' : catalogueOnly ? 'catalogue' : 'live'}.json`, serialized + '\n'); db.close();
}
