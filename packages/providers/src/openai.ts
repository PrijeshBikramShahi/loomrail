import { generationRequestSchema, generationResponseSchema, LoomrailError, type GenerationRequest, type GenerationResponse, type Provider } from '@loomrail/contracts';
import { assertProviderRequest } from './index.js';
import { boundedJson, object, type Fetcher } from './http.js';

/** Explicit OpenAI Chat Completions adapter; no generic "compatible" provider claim. */
export class OpenAIProvider implements Provider {
  readonly id = 'openai';
  readonly capabilities = { toolCalls: true, structuredOutputs: true, streaming: false, embeddings: false, usageReporting: true };
  constructor(private options: { apiKey?: string; enabled: boolean; fetcher?: Fetcher }) {}
  async generate(value: GenerationRequest, signal?: AbortSignal): Promise<GenerationResponse> {
    const request = generationRequestSchema.parse(value); assertProviderRequest(this, request, this.options.enabled);
    if (request.model.mode !== 'remote') throw new LoomrailError({ code: 'INVALID_INPUT', message: 'OpenAI adapter requires remote mode.', retryable: false });
    if (!this.options.apiKey) throw new LoomrailError({ code: 'PROVIDER_UNAVAILABLE', message: 'OPENAI_API_KEY is not configured on the server.', retryable: false });
    const messages = request.messages.map(message => {
      if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: JSON.stringify(message.content) };
      if (message.role === 'assistant') return { role: 'assistant', content: message.content, ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) };
      return { role: message.role === 'system' ? 'developer' : message.role, content: message.content };
    });
    const body = { model: request.model.model, messages, temperature: request.settings.temperature, max_completion_tokens: request.settings.maxOutputTokens, stream: false, store: false,
      ...(request.outputSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'agent_output', strict: true, schema: request.outputSchema } } } : {}),
      ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true } })), parallel_tool_calls: false } : {}),
    };
    const raw = object(await boundedJson('https://api.openai.com/v1/chat/completions', body, request, signal, this.options.fetcher ?? fetch, { Authorization: `Bearer ${this.options.apiKey}` }));
    try {
      const choice = object(Array.isArray(raw.choices) ? raw.choices[0] : null); const message = object(choice.message); const usage = object(raw.usage);
      if (message.refusal) throw new Error('Refusal');
      const content = typeof message.content === 'string' ? message.content : '';
      const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(value => { const call = object(value); const fn = object(call.function); return { id: call.id, name: fn.name, arguments: JSON.parse(String(fn.arguments)) }; });
      return generationResponseSchema.parse({ schemaVersion: 1, model: { ...request.model, model: typeof raw.model === 'string' ? raw.model : request.model.model, ...(typeof raw.system_fingerprint === 'string' ? { revision: raw.system_fingerprint } : {}) }, content, toolCalls,
        ...(request.outputSchema && !toolCalls.length && choice.finish_reason !== 'length' ? { structuredOutput: JSON.parse(content) } : {}),
        usage: { inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, estimatedCostUsd: null },
        finishReason: choice.finish_reason === 'length' ? 'output_limit' : toolCalls.length ? 'tool_calls' : 'completed',
      });
    } catch { throw new LoomrailError({ code: 'INVALID_OUTPUT', message: 'OpenAI returned a refusal or malformed output. No provider fallback was used.', retryable: false }); }
  }
}
