import { setTimeout } from 'node:timers/promises';
import { generationRequestSchema, generationResponseSchema, LoomrailError, type GenerationRequest, type GenerationResponse, type Provider, type JsonValue } from '@loomrail/contracts';
import { assertProviderRequest } from './index.js';
import { object } from './http.js';

export const fixtureModels = ['catalogue-v1', 'tool-demo-v1', 'conflict-v1', 'echo-v1', 'malformed-v1', 'unavailable-v1', 'quota-v1', 'unauthorized-v1', 'timeout-v1', 'limit-v1', 'loop-v1'] as const;
export class FixtureProvider implements Provider {
  readonly id = 'fixture';
  readonly capabilities = { toolCalls: true, structuredOutputs: true, streaming: false, embeddings: false, usageReporting: false };
  async generate(value: GenerationRequest, signal?: AbortSignal): Promise<GenerationResponse> {
    const request = generationRequestSchema.parse(value); assertProviderRequest(this, request, false);
    if (request.model.mode !== 'fixture') throw new LoomrailError({ code: 'INVALID_INPUT', message: 'Fixture adapter requires fixture mode.', retryable: false });
    if (signal?.aborted) throw new LoomrailError({ code: 'CANCELLED', message: 'Fixture request cancelled.', retryable: false });
    const model = request.model.model;
    if (!fixtureModels.includes(model as typeof fixtureModels[number]) || model === 'unavailable-v1') throw new LoomrailError({ code: 'PROVIDER_UNAVAILABLE', message: 'Fixture model unavailable (simulated).', retryable: false });
    if (model === 'quota-v1') throw new LoomrailError({ code: 'QUOTA_EXCEEDED', message: 'Fixture quota exhausted (simulated).', retryable: false });
    if (model === 'timeout-v1') {
      try { await setTimeout(request.limits.timeoutMs + 10, undefined, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(request.limits.timeoutMs)]) : AbortSignal.timeout(request.limits.timeoutMs) }); }
      catch { throw new LoomrailError({ code: signal?.aborted ? 'CANCELLED' : 'TIMEOUT', message: 'Fixture request interrupted (simulated).', retryable: false }); }
    }
    const response: GenerationResponse = { schemaVersion: 1, model: { ...request.model, revision: 'fixture-1' }, content: '', toolCalls: [], usage: { inputTokens: null, outputTokens: null, estimatedCostUsd: null }, finishReason: 'completed' };
    let input: Record<string, unknown> = {};
    try { input = object(JSON.parse(request.messages.find(message => message.role === 'user')?.content as string ?? '{}')); } catch { /* fixture input may be ordinary text */ }
    const toolResults = request.messages.filter(message => message.role === 'tool');
    if (model === 'unauthorized-v1') response.toolCalls = [{ id: 'unauthorized-1', name: 'send_email', arguments: { to: 'nobody@example.invalid' } }];
    else if ((['tool-demo-v1', 'conflict-v1'].includes(model) && !toolResults.length) || model === 'loop-v1') {
      response.toolCalls = [{ id: `record-${toolResults.length}`, name: 'record_lookup', arguments: { sku: String(input.sku ?? 'DEMO-001') } }, { id: `guidelines-${toolResults.length}`, name: 'guideline_search', arguments: { query: 'listing' } }];
    } else {
      const record = object(toolResults.map(message => object(message.content).record).find(Boolean));
      const sources = toolResults.flatMap(message => Array.isArray(object(message.content).sources) ? object(message.content).sources as unknown[] : []);
      const facts = { ...input, ...record };
      const output: JsonValue = model === 'echo-v1' ? input as JsonValue : model === 'malformed-v1' ? { invalid: true } : {
        sku: String(facts.sku ?? ''), title: String(facts.name ?? facts.title ?? 'Untitled supplier record'),
        description: `Fixture draft for ${String(facts.name ?? facts.title ?? 'supplier record')}. Verify specifications before approval.`,
        price: typeof facts.price === 'number' ? facts.price : null,
        sourceReferences: sources.map(source => String(object(source).id)),
        flags: [...(model === 'conflict-v1' ? ['conflicting_guidelines'] : []), ...(typeof facts.price === 'number' ? [] : ['missing_price']), ...(sources.length ? [] : ['no_guidelines'])],
      };
      response.structuredOutput = output; response.content = JSON.stringify(output);
    }
    if (response.toolCalls.length) response.finishReason = 'tool_calls';
    if (model === 'limit-v1') response.finishReason = 'output_limit';
    return generationResponseSchema.parse(response);
  }
}
