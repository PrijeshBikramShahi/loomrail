import { describe, expect, it, vi } from 'vitest';
import { agentDefinitionSchema, defaultAgent, type GenerationRequest } from '@loomrail/contracts';
import { LAGUNA_FREE_MODEL, OpenRouterProvider } from '../src/index.js';

const request: GenerationRequest = { schemaVersion: 1, model: { provider: 'openrouter', model: LAGUNA_FREE_MODEL, mode: 'remote' }, outputMode: 'prompt_json', messages: [{ role: 'user', content: 'Return ok=true.' }], tools: [], outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, settings: { temperature: 0, maxOutputTokens: 100 }, limits: { maxInputBytes: 5000, maxToolCalls: 2, timeoutMs: 1000 } };
const completion = (content: string) => Response.json({ model: LAGUNA_FREE_MODEL, choices: [{ message: { content, reasoning: 'Do not persist hidden reasoning' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0 } });

describe('OpenRouter free Laguna adapter', () => {
  it('requires opt-in, a credential, an exact free model, and explicit output mode before network access', async () => {
    const fetcher = vi.fn();
    for (const [options, input] of [
      [{ enabled: false, apiKey: 'private' }, request],
      [{ enabled: true }, request],
      [{ enabled: true, apiKey: 'private' }, { ...request, model: { ...request.model, model: 'poolside/laguna-s-2.1' } }],
      [{ enabled: true, apiKey: 'private' }, { ...request, outputMode: undefined }],
    ] as const) await expect(new OpenRouterProvider({ ...options, fetcher }).generate(input)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(agentDefinitionSchema.safeParse({ ...defaultAgent, model: request.model }).success).toBe(false);
    expect(agentDefinitionSchema.safeParse({ ...defaultAgent, model: request.model, outputMode: 'prompt_json' }).success).toBe(true);
  });
  it('enforces free routing, validates prompted JSON, and omits hidden reasoning and credentials', async () => {
    const fetcher = vi.fn(async () => completion('{"ok":true}'));
    const provider = new OpenRouterProvider({ enabled: true, apiKey: 'private', fetcher });
    const result = await provider.generate(request);
    expect(provider.capabilities.structuredOutputs).toBe(true); // Available only for explicitly supported native-schema models.
    expect(result).toMatchObject({ structuredOutput: { ok: true }, usage: { estimatedCostUsd: 0 } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]; const body = JSON.parse(String(init.body));
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body).toMatchObject({ model: LAGUNA_FREE_MODEL, provider: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0 } } });
    expect(body.response_format).toBeUndefined(); expect(body.models).toBeUndefined();
    expect(body.messages[0].content).toContain(JSON.stringify(request.outputSchema));
    expect(JSON.stringify(result)).not.toContain('hidden reasoning'); expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each(['not JSON', '{"ok":"yes"}', '```json\n{"ok":true}\n```'])('fails closed on invalid final output %s', async content => {
    await expect(new OpenRouterProvider({ enabled: true, apiKey: 'private', fetcher: async () => completion(content) }).generate(request)).rejects.toMatchObject({ details: { code: 'INVALID_OUTPUT' } });
  });
  it('requests native JSON Schema for Nemotron and refuses a silent downgrade', async () => {
    const fetcher = vi.fn(async () => completion('{"ok":true}'));
    const native: GenerationRequest = { ...request, model: { ...request.model, model: 'nvidia/nemotron-3-super-120b-a12b:free' }, outputMode: 'native_schema' };
    const provider = new OpenRouterProvider({ enabled: true, apiKey: 'private', fetcher });
    await provider.generate(native);
    const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.model).toBe(native.model.model);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'agent_output', strict: true, schema: request.outputSchema } });
    expect(body.provider.max_price).toEqual({ prompt: 0, completion: 0 });
    expect(agentDefinitionSchema.safeParse({ ...defaultAgent, model: native.model, outputMode: 'native_schema' }).success).toBe(true);
    await expect(provider.generate({ ...native, outputMode: 'prompt_json' })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves tool identities and results across request rounds', async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'record_lookup', arguments: '{"sku":"TEST"}' } }] } }] }));
    const provider = new OpenRouterProvider({ enabled: true, apiKey: 'private', fetcher });
    const first = await provider.generate(request); expect(first.toolCalls[0]).toEqual({ id: 'call-1', name: 'record_lookup', arguments: { sku: 'TEST' } });
    await provider.generate({ ...request, messages: [...request.messages, { role: 'assistant', content: first.content, toolCalls: first.toolCalls }, { role: 'tool', toolCallId: 'call-1', content: { record: null } }] });
    const body = JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '{"record":null}' });
  });
  it('separates the required Nemotron tool round from schema-constrained final output', async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'record_lookup', arguments: '{"sku":"TEST"}' } }] } }] }));
    const native: GenerationRequest = { ...request, model: { ...request.model, model: 'nvidia/nemotron-3-super-120b-a12b:free' }, outputMode: 'native_schema', tools: [{ name: 'record_lookup', description: 'Read a fictional record', inputSchema: { type: 'object' } }] };
    const provider = new OpenRouterProvider({ enabled: true, apiKey: 'private', fetcher }); const response = await provider.generate(native);
    const first = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(first.tool_choice).toBe('required'); expect(first.response_format).toBeUndefined();
    await provider.generate({ ...native, messages: [...native.messages, { role: 'assistant', content: '', toolCalls: response.toolCalls }, { role: 'tool', toolCallId: 'read', content: { record: null } }] });
    const second = JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(second.response_format.type).toBe('json_schema'); expect(second.tool_choice).toBeUndefined();
    const withGuidelines = { ...native, tools: [...native.tools, { name: 'guideline_search', description: 'Read guidelines', inputSchema: { type: 'object' } }], messages: [...native.messages, { role: 'assistant' as const, content: '', toolCalls: response.toolCalls }, { role: 'tool' as const, toolCallId: 'read', content: { record: null } }] };
    await provider.generate(withGuidelines);
    const pending = JSON.parse(String((fetcher.mock.calls[2] as unknown as [string, RequestInit])[1].body));
    expect(pending.tool_choice).toBe('required'); expect(pending.response_format).toBeUndefined(); expect(pending.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['guideline_search']);
    await expect(new OpenRouterProvider({ enabled: true, apiKey: 'private', fetcher: async () => completion('{"ok":true}') }).generate(native)).rejects.toMatchObject({ details: { code: 'INVALID_OUTPUT' } });
  });
  it('handles quota errors in HTTP and response envelopes without exposing provider diagnostics', async () => {
    for (const response of [new Response('private', { status: 429 }), Response.json({ error: { code: 429, message: 'private' } })]) {
      await expect(new OpenRouterProvider({ enabled: true, apiKey: 'private', fetcher: async () => response }).generate(request)).rejects.toMatchObject({ details: { code: 'QUOTA_EXCEEDED' } });
    }
  });
});
