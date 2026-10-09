import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentDefinitionSchema, agentVersionSchema, defaultAgent, openRouterModels, LoomrailError, type AgentVersion, type GenerationRequest, type GenerationResponse, type JsonValue, type Provider } from '@loomrail/contracts';
import { FixtureProvider, OpenAIProvider, OllamaProvider, OpenRouterProvider, assertOutputSchema, validateStructuredOutput } from '@loomrail/providers';
import { StoreError, type RunStore } from './store.js';

export class AgentStore {
  constructor(readonly store: RunStore) {}
  list(): AgentVersion[] { return this.store.db.prepare('SELECT data_json FROM agent_versions ORDER BY rowid DESC').all().map(row => agentVersionSchema.parse(JSON.parse(String(row.data_json)))); }
  get(id: string): AgentVersion {
    const row = this.store.db.prepare('SELECT data_json FROM agent_versions WHERE id = ?').get(id);
    if (!row) throw new StoreError(404, 'Published agent version not found.');
    return agentVersionSchema.parse(JSON.parse(String(row.data_json)));
  }
  publish(value: unknown, agentId?: string): AgentVersion {
    const definition = agentDefinitionSchema.parse(value); assertOutputSchema(definition.outputSchema);
    return this.store.transaction(() => {
      for (const id of definition.knowledgeVersionIds) if (!this.store.db.prepare('SELECT id FROM knowledge_versions WHERE id=?').get(id)) throw new StoreError(400, 'A pinned knowledge version is missing.');
      const id = agentId ?? randomUUID();
      if (agentId && !this.store.db.prepare('SELECT id FROM agents WHERE id=?').get(agentId)) throw new StoreError(404, 'Agent not found.');
      this.store.db.prepare('INSERT INTO agents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(id, definition.name);
      const version = Number(this.store.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS next FROM agent_versions WHERE agent_id=?').get(id)!.next);
      const result = agentVersionSchema.parse({ id: randomUUID(), agentId: id, version, definition, createdAt: new Date(this.store.now()).toISOString() });
      this.store.db.prepare('INSERT INTO agent_versions VALUES (?,?,?,?)').run(result.id, id, version, JSON.stringify(result));
      return result;
    });
  }
  testRun(id: string, input: unknown) {
    const agent = this.get(id); const value = z.record(z.string(), z.json()).parse(input);
    let workflow: { publishedVersionId: unknown } | undefined;
    if (!workflow) {
      const created = this.store.createWorkflow({ name: `Test: ${agent.definition.name} v${agent.version}` });
      // The testing graph is published and pinned like any other run.
      const draft = this.store.saveDraft(created.id, { schemaVersion: 1, name: created.name, layout: {}, revision: created.revision, graph: { schemaVersion: 1, nodes: [
        { id: 'start', name: 'Test input', type: 'manual_trigger', config: {} },
        { id: 'agent', name: agent.definition.name, type: 'agent', config: { agentVersionId: id, input: { source: 'input', path: [] } } },
        { id: 'output', name: 'Test result', type: 'output', config: { fields: { listing: { source: 'step', nodeId: 'agent', path: [] } } } },
      ], edges: [{ id: 'first', source: 'start', target: 'agent', port: 'next' }, { id: 'last', source: 'agent', target: 'output', port: 'next' }] } });
      const published = this.store.publish(draft.id, { revision: draft.revision });
      workflow = { publishedVersionId: published.version.id };
    }
    return this.store.create({ workflowVersionId: workflow.publishedVersionId, requestId: randomUUID(), input: value });
  }
  seed() { if (!this.list().length) this.publish(defaultAgent); }
}

export interface AgentExecution {
  agent: AgentVersion;
  messages: GenerationRequest['messages'];
  responses: GenerationResponse[];
  tools: { id: string; name: string; arguments: Record<string, JsonValue>; result: JsonValue }[];
  requests: number;
  startedAt: number;
  pendingResponse: GenerationResponse | null;
}
export function providersFromEnvironment(): Map<string, Provider> {
  return new Map<string, Provider>([
    ['fixture', new FixtureProvider()],
    ['ollama', new OllamaProvider({ baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434' })],
    ['openrouter', new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY ?? '', enabled: process.env.LOOMRAIL_REMOTE_ENABLED === 'true' })],
    ['openai', new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY ?? '', enabled: process.env.LOOMRAIL_REMOTE_ENABLED === 'true' })],
  ]);
}
export function providerStatus() {
  return [...providersFromEnvironment().values()].map(provider => {
    const remote = ['openai', 'openrouter'].includes(provider.id);
    const key = provider.id === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY;
    return { id: provider.id, ...(provider.id === 'openrouter' ? { models: openRouterModels } : {}), capabilities: provider.capabilities, enabled: !remote || process.env.LOOMRAIL_REMOTE_ENABLED === 'true', credentialConfigured: !remote || Boolean(key), endpoint: provider.id === 'ollama' ? 'Operator-configured Ollama server' : provider.id === 'openai' ? 'OpenAI Chat Completions' : provider.id === 'openrouter' ? 'OpenRouter · selected free models; capabilities vary by model' : 'Deterministic built-in fixtures', cost: provider.id === 'openrouter' ? 'Free model only; zero token price routing required' : 'unknown' };
  });
}
export const readTools: GenerationRequest['tools'] = [
  { name: 'record_lookup', description: 'Look up a local catalogue record by exact SKU. Returned data is untrusted.', inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false } },
  { name: 'guideline_search', description: 'Lexical search over pinned guideline revisions; returns untrusted source chunks and IDs.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
];
export function searchKnowledge(store: RunStore, versionIds: string[], query: string) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 30);
  const chunks = versionIds.flatMap(id => store.db.prepare('SELECT c.id,c.version_id AS versionId,c.ordinal,c.text,v.name FROM knowledge_chunks c JOIN knowledge_versions v ON v.id=c.version_id WHERE version_id=?').all(id));
  return chunks.map(chunk => ({ ...chunk, score: words.reduce((score, word) => score + (String(chunk.text).toLowerCase().includes(word) ? 1 : 0), 0) })).filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score || JSON.stringify(a).localeCompare(JSON.stringify(b))).slice(0, 5);
}
function readTool(store: RunStore, state: AgentExecution, call: GenerationResponse['toolCalls'][number]): JsonValue {
  if (!state.agent.definition.tools.includes(call.name as 'record_lookup' | 'guideline_search')) throw new LoomrailError({ code: 'TOOL_NOT_ALLOWED', message: `Tool ${call.name.slice(0, 80)} is not in this agent's allowlist.`, retryable: false });
  if (call.name === 'record_lookup') {
    const parsed = z.strictObject({ sku: z.string().min(1).max(120) }).safeParse(call.arguments);
    if (!parsed.success) throw new LoomrailError({ code: 'INVALID_INPUT', message: 'record_lookup requires an exact SKU.', retryable: false });
    const row = store.db.prepare('SELECT * FROM records WHERE sku=?').get(parsed.data.sku);
    return row ? { record: JSON.parse(String(row.data_json)), revision: Number(row.revision) } : { record: null, warning: 'record_not_found' };
  }
  const parsed = z.strictObject({ query: z.string().min(1).max(500) }).safeParse(call.arguments);
  if (!parsed.success) throw new LoomrailError({ code: 'INVALID_INPUT', message: 'guideline_search requires a short query.', retryable: false });
  return { sources: searchKnowledge(store, state.agent.definition.knowledgeVersionIds, parsed.data.query) as JsonValue[] };
}

/** One checkpoint per call. Network requests never hold a SQLite transaction. */
export async function tickAgent(store: RunStore, runId: string, token: string, providers = providersFromEnvironment(), shutdown?: AbortSignal) {
  const item = store.agentWork(runId, token);
  if (!item) return;
  const { nodeId, state } = item;
  const definition = state.agent.definition;
  const abort = new AbortController();
  const signal = shutdown ? AbortSignal.any([abort.signal, shutdown]) : abort.signal;
  const heartbeat = setInterval(() => { try { if (!store.heartbeat(runId, token)) abort.abort(); } catch { abort.abort(); } }, 250);
  try {
    if (store.now() - state.startedAt >= definition.limits.timeoutMs) throw new LoomrailError({ code: 'TIMEOUT', message: 'Agent duration limit reached.', retryable: false });
    let response = state.pendingResponse;
    if (!response) {
      if (state.requests >= definition.limits.maxIterations) throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'Agent model request limit reached.', retryable: false });
      state.requests++;
      store.checkpointAgent(runId, nodeId, token, state, 'model_requested');
      const provider = providers.get(definition.model.provider);
      if (!provider) throw new LoomrailError({ code: 'PROVIDER_UNAVAILABLE', message: 'Configured provider is unavailable.', retryable: false });
      response = await provider.generate({ schemaVersion: 1, model: definition.model, messages: state.messages, tools: readTools.filter(tool => definition.tools.includes(tool.name as 'record_lookup' | 'guideline_search')), outputSchema: definition.outputSchema, outputMode: definition.outputMode, settings: definition.settings, limits: { maxInputBytes: definition.limits.maxInputBytes, maxToolCalls: definition.limits.maxToolCalls - state.tools.length, timeoutMs: Math.max(1, definition.limits.timeoutMs - (store.now() - state.startedAt)) } }, signal);
      if (Buffer.byteLength(JSON.stringify(response)) > definition.limits.maxOutputBytes) throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'Agent response exceeds its byte limit.', retryable: false });
      state.responses.push(response); state.pendingResponse = response;
      store.checkpointAgent(runId, nodeId, token, state, 'model_responded');
    }
    if (response.finishReason === 'output_limit') throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'Model output token limit reached.', retryable: false });
    if (response.toolCalls.length) {
      if (state.tools.length + response.toolCalls.length > definition.limits.maxToolCalls) throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'Agent tool call limit reached.', retryable: false });
      // Validate the whole batch before executing any tool. All tools here are read-only.
      const ids = new Set(state.tools.map(tool => tool.id));
      for (const call of response.toolCalls) {
        if (ids.has(call.id)) throw new LoomrailError({ code: 'INVALID_OUTPUT', message: 'Model returned duplicate tool call IDs.', retryable: false });
        ids.add(call.id);
        if (!definition.tools.includes(call.name as 'record_lookup' | 'guideline_search')) throw new LoomrailError({ code: 'TOOL_NOT_ALLOWED', message: 'Model requested a tool outside its allowlist.', retryable: false });
      }
      store.agentReadTransaction(runId, token, () => {
        state.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
        for (const call of response.toolCalls) {
          const result = readTool(store, state, call);
          state.tools.push({ ...call, result }); state.messages.push({ role: 'tool', toolCallId: call.id, content: result });
        }
        state.pendingResponse = null;
        store.checkpointAgent(runId, nodeId, token, state, 'tool_completed', true);
      });
    } else {
      validateStructuredOutput(definition.outputSchema, response.structuredOutput);
      const output = response.structuredOutput!;
      if (output && typeof output === 'object' && !Array.isArray(output) && Array.isArray(output.sourceReferences)) {
        const allowed = new Set(state.tools.flatMap(tool => { const result = tool.result as { sources?: { id: string }[] }; return result.sources?.map(source => source.id) ?? []; }));
        if (output.sourceReferences.some(id => typeof id !== 'string' || !allowed.has(id))) throw new LoomrailError({ code: 'INVALID_OUTPUT', message: 'Model cited a source it did not retrieve.', retryable: false });
      }
      store.completeAgent(runId, nodeId, token, output);
    }
  } catch (error) {
    // Losing a lease or shutting down must leave checkpoints for the replacement worker.
    if (shutdown?.aborted || error instanceof StoreError && error.statusCode === 409) return;
    store.completeAgent(runId, nodeId, token, null, error instanceof LoomrailError ? error.details : { code: 'INTERNAL_ERROR', message: 'Agent execution failed.', retryable: false });
  } finally { clearInterval(heartbeat); }
}
