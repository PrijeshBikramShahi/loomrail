import { randomUUID } from 'node:crypto';
import { generationRequestSchema, generationResponseSchema, LoomrailError, type GenerationRequest, type GenerationResponse, type Provider } from '@loomrail/contracts';
import { assertProviderRequest } from './index.js';
import { boundedJson, object, type Fetcher } from './http.js';

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly capabilities = { toolCalls: true, structuredOutputs: true, streaming: false, embeddings: false, usageReporting: true };
  constructor(private options: { baseUrl?: string; fetcher?: Fetcher } = {}) {
    const url = new URL(options.baseUrl ?? 'http://127.0.0.1:11434');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid operator-configured Ollama URL.');
  }
  async generate(value: GenerationRequest, signal?: AbortSignal): Promise<GenerationResponse> {
    const request = generationRequestSchema.parse(value); assertProviderRequest(this, request, false);
    if (request.model.mode !== 'local') throw new LoomrailError({ code: 'INVALID_INPUT', message: 'Ollama adapter requires local mode.', retryable: false });
    const messages = request.messages.map(message => message.role === 'tool'
      ? { role: 'tool', tool_name: request.messages.flatMap(item => item.role === 'assistant' ? item.toolCalls : []).find(call => call.id === message.toolCallId)?.name, content: JSON.stringify(message.content) }
      : message.role === 'assistant' ? { role: 'assistant', content: message.content, tool_calls: message.toolCalls.map(call => ({ function: { name: call.name, arguments: call.arguments } })) } : message);
    const body = { model: request.model.model, messages, stream: false, think: false, options: { temperature: request.settings.temperature, num_predict: request.settings.maxOutputTokens },
      ...(request.outputSchema ? { format: request.outputSchema } : {}), ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}) };
    const raw = object(await boundedJson(new URL('/api/chat', this.options.baseUrl ?? 'http://127.0.0.1:11434').href, body, request, signal, this.options.fetcher ?? fetch));
    try {
      const message = object(raw.message); if (raw.error || typeof message.content !== 'string') throw new Error('Invalid message');
      const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(value => { const fn = object(object(value).function); return { id: randomUUID(), name: fn.name, arguments: fn.arguments }; });
      return generationResponseSchema.parse({ schemaVersion: 1, model: { ...request.model, model: typeof raw.model === 'string' ? raw.model : request.model.model }, content: message.content, toolCalls,
        ...(request.outputSchema && !toolCalls.length && raw.done_reason !== 'length' ? { structuredOutput: JSON.parse(message.content) } : {}),
        usage: { inputTokens: raw.prompt_eval_count ?? null, outputTokens: raw.eval_count ?? null, estimatedCostUsd: null },
        finishReason: raw.done_reason === 'length' ? 'output_limit' : toolCalls.length ? 'tool_calls' : 'completed' });
    } catch { throw new LoomrailError({ code: 'INVALID_OUTPUT', message: 'Ollama returned malformed output.', retryable: false }); }
  }
}
