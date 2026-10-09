import { generationRequestSchema, generationResponseSchema, openRouterModels, LoomrailError, type GenerationRequest, type GenerationResponse, type Provider } from '@loomrail/contracts';
import { assertProviderRequest } from './index.js';
import { boundedJson, object, type Fetcher } from './http.js';
import { validateStructuredOutput } from './schema.js';

export const LAGUNA_FREE_MODEL = 'poolside/laguna-s-2.1:free';

/** Allowlisted free-model integration with explicit per-model output semantics and no paid fallback. */
export class OpenRouterProvider implements Provider {
  readonly id = 'openrouter';
  readonly capabilities = { toolCalls: true, structuredOutputs: true, streaming: false, embeddings: false, usageReporting: true };
  constructor(private options: { apiKey?: string; enabled: boolean; fetcher?: Fetcher }) {}
  async generate(value: GenerationRequest, signal?: AbortSignal): Promise<GenerationResponse> {
    const request = generationRequestSchema.parse(value);
    const selected = openRouterModels.find(model => model.id === request.model.model);
    if (!selected || request.model.mode !== 'remote' || (request.outputMode ?? 'native_schema') !== selected.outputMode) throw new LoomrailError({ code: 'INVALID_INPUT', message: 'Choose an explicitly supported free OpenRouter model and its output mode. Paid routing is disabled.', retryable: false });
    assertProviderRequest({ id: this.id, capabilities: { ...this.capabilities, structuredOutputs: selected.outputMode === 'native_schema' } }, request, this.options.enabled);
    if (!this.options.apiKey) throw new LoomrailError({ code: 'PROVIDER_UNAVAILABLE', message: 'OPENROUTER_API_KEY is not configured on the server.', retryable: false });
    // Native-schema agents read each configured tool before the constrained final response.
    // Match completed results by call ID, not merely by an assistant's requested tool name.
    const completedIds = new Set(request.messages.flatMap(message => message.role === 'tool' ? [message.toolCallId] : []));
    const completedTools = new Set(request.messages.flatMap(message => message.role === 'assistant' ? message.toolCalls.filter(call => completedIds.has(call.id)).map(call => call.name) : []));
    const tools = selected.outputMode === 'native_schema' ? request.tools.filter(tool => !completedTools.has(tool.name)) : request.tools;
    const toolPhase = selected.outputMode === 'native_schema' && tools.length > 0;
    const messages = request.messages.map(message => {
      if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: JSON.stringify(message.content) };
      if (message.role === 'assistant') return { role: 'assistant', content: message.content, ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) };
      return message;
    });
    if (request.outputSchema && selected.outputMode === 'prompt_json') messages.unshift({ role: 'system', content: `After using any necessary tools, return only one JSON value matching this schema, without Markdown or commentary. Missing facts must remain unknown; do not invent them. Your final JSON will be validated by the application. Schema: ${JSON.stringify(request.outputSchema)}` });
    const body = { model: selected.id, messages, temperature: request.settings.temperature, max_tokens: request.settings.maxOutputTokens, stream: false,
      ...(request.outputSchema && selected.outputMode === 'native_schema' && !toolPhase ? { response_format: { type: 'json_schema', json_schema: { name: 'agent_output', strict: true, schema: request.outputSchema } } } : {}),
      ...(toolPhase ? { tool_choice: 'required' } : {}),
      reasoning: { exclude: true }, provider: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0 } },
      ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(body)) > request.limits.maxInputBytes) throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'OpenRouter request including the output schema exceeds the input byte limit.', retryable: false });
    const raw = object(await boundedJson('https://openrouter.ai/api/v1/chat/completions', body, request, signal, this.options.fetcher ?? fetch, { Authorization: `Bearer ${this.options.apiKey}`, 'X-OpenRouter-Title': 'Loomrail' }));
    if (raw.error) {
      const code = object(raw.error).code;
      throw new LoomrailError({ code: code === 429 ? 'QUOTA_EXCEEDED' : 'PROVIDER_UNAVAILABLE', message: 'OpenRouter reported a provider error. No model fallback was used.', retryable: typeof code === 'number' && code >= 500 });
    }
    try {
      const choice = object(Array.isArray(raw.choices) ? raw.choices[0] : null); const message = object(choice.message); const usage = object(raw.usage);
      if (message.refusal || !['stop', 'tool_calls', 'length'].includes(String(choice.finish_reason))) throw new Error('Invalid completion');
      const content = typeof message.content === 'string' ? message.content : '';
      const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(value => { const call = object(value); const fn = object(call.function); return { id: call.id, name: fn.name, arguments: JSON.parse(String(fn.arguments)) }; });
      if (toolPhase && !toolCalls.length && choice.finish_reason !== 'length') throw new Error('Required tool round was skipped');
      const structuredOutput = request.outputSchema && !toolCalls.length && choice.finish_reason !== 'length' ? JSON.parse(content) : undefined;
      if (structuredOutput !== undefined) validateStructuredOutput(request.outputSchema!, structuredOutput);
      return generationResponseSchema.parse({ schemaVersion: 1, model: { ...request.model, model: typeof raw.model === 'string' ? raw.model : request.model.model }, content, toolCalls,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        usage: { inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, estimatedCostUsd: typeof usage.cost === 'number' ? usage.cost : null },
        finishReason: choice.finish_reason === 'length' ? 'output_limit' : toolCalls.length ? 'tool_calls' : 'completed' });
    } catch { throw new LoomrailError({ code: 'INVALID_OUTPUT', message: 'OpenRouter model returned a refusal, malformed tool call, or JSON that did not satisfy the output schema.', retryable: false }); }
  }
}
