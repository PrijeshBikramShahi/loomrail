import { describe, expect, it, vi } from 'vitest';
import { FixtureProvider, OpenAIProvider, OllamaProvider, validateStructuredOutput } from '../src/index.js';
import type { GenerationRequest } from '@loomrail/contracts';
const request: GenerationRequest = { schemaVersion: 1, model: { provider: 'openai', model: 'operator-model', mode: 'remote' }, messages: [{ role: 'system', content: 'Test' }, { role: 'user', content: '{}' }], tools: [], outputSchema: { type: 'object' }, settings: { temperature: 0, maxOutputTokens: 10 }, limits: { maxInputBytes: 5000, maxToolCalls: 1, timeoutMs: 1000 } };
describe('provider adapters', () => {
  it('requires explicit remote opt-in and never calls a fallback', async () => { const fetcher = vi.fn(); await expect(new OpenAIProvider({ enabled: false, apiKey: 'private', fetcher }).generate(request)).rejects.toMatchObject({ details: { code: 'TOOL_NOT_ALLOWED' } }); expect(fetcher).not.toHaveBeenCalled(); });
  it('maps the documented OpenAI request and response including reported usage', async () => {
    const fetcher = vi.fn(async () => Response.json({ model: 'exact-model', system_fingerprint: 'revision', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } }));
    const result = await new OpenAIProvider({ enabled: true, apiKey: 'private', fetcher }).generate(request);
    expect(result).toMatchObject({ model: { model: 'exact-model', revision: 'revision' }, structuredOutput: { ok: true }, usage: { inputTokens: 12, outputTokens: 5, estimatedCostUsd: null } });
    const args = fetcher.mock.calls[0] as unknown as [string, RequestInit]; expect(args[0]).toBe('https://api.openai.com/v1/chat/completions'); expect(JSON.parse(String(args[1].body))).toMatchObject({ store: false, stream: false, response_format: { type: 'json_schema' } }); expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([[429,'QUOTA_EXCEEDED'],[503,'PROVIDER_UNAVAILABLE'],[400,'INVALID_INPUT']])('normalizes HTTP %s without leaking response bodies', async (status, code) => { const fetcher = vi.fn(async () => new Response('private diagnostic secret', { status })); await expect(new OpenAIProvider({ enabled: true, apiKey: 'private', fetcher }).generate(request)).rejects.toMatchObject({ details: { code } }); });
  it('rejects malformed and oversized responses', async () => {
    for (const body of ['not json', 'a'.repeat(1_000_001)]) await expect(new OpenAIProvider({ enabled: true, apiKey: 'private', fetcher: async () => new Response(body) }).generate(request)).rejects.toThrow();
  });
  it('normalizes abort and timeout', async () => {
    const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => { if (options?.signal?.aborted) reject(new Error('abort')); else options?.signal?.addEventListener('abort', () => reject(new Error('abort')), { once: true }); });
    const provider = new OpenAIProvider({ enabled: true, apiKey: 'private', fetcher });
    await expect(provider.generate({ ...request, limits: { ...request.limits, timeoutMs: 10 } })).rejects.toMatchObject({ details: { code: 'TIMEOUT' } });
    await expect(provider.generate(request, AbortSignal.abort())).rejects.toMatchObject({ details: { code: 'CANCELLED' } });
  });
  it('normalizes Ollama structured output without claiming known cost', async () => { const result = await new OllamaProvider({ fetcher: async () => Response.json({ model: 'local', message: { content: '{"ok":true}' }, done_reason: 'stop', eval_count: 3 }) }).generate({ ...request, model: { provider: 'ollama', model: 'local', mode: 'local' } }); expect(result.usage).toEqual({ inputTokens: null, outputTokens: 3, estimatedCostUsd: null }); });
  it('keeps fixture behavior deterministic and enforces schema validation', async () => { const provider = new FixtureProvider(); const fixture = { ...request, model: { provider: 'fixture', model: 'echo-v1', mode: 'fixture' as const } }; expect(await provider.generate(fixture)).toEqual(await provider.generate(fixture)); expect(() => validateStructuredOutput({ type: 'object', required: ['title'], properties: { title: { type: 'string' } } }, {})).toThrow('JSON Schema'); });
});
