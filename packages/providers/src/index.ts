import { LoomrailError, type GenerationRequest, type Provider, type ProviderCapabilities } from '@loomrail/contracts';

/** Check before invoking an adapter. Never silently switch provider or drop features. */
export function assertCapabilities(capabilities: ProviderCapabilities, required: Partial<ProviderCapabilities>): void {
  for (const key of Object.keys(required) as (keyof ProviderCapabilities)[]) {
    if (required[key] && !capabilities[key]) {
      throw new LoomrailError({ code: 'CAPABILITY_UNSUPPORTED', message: `Provider does not support ${key}.`, retryable: false });
    }
  }
}

export function assertProviderRequest(provider: Pick<Provider, 'id' | 'capabilities'>, request: GenerationRequest, remoteEnabled: boolean): void {
  if (request.model.provider !== provider.id) {
    throw new LoomrailError({ code: 'INVALID_INPUT', message: 'Selected provider does not match the request.', retryable: false });
  }
  if (request.model.mode === 'remote' && !remoteEnabled) {
    throw new LoomrailError({ code: 'TOOL_NOT_ALLOWED', message: 'Remote inference requires explicit operator configuration.', retryable: false });
  }
  if (request.outputMode === 'prompt_json' && provider.id !== 'openrouter') throw new LoomrailError({ code: 'CAPABILITY_UNSUPPORTED', message: 'This provider does not support prompted JSON mode.', retryable: false });
  assertCapabilities(provider.capabilities, { toolCalls: request.tools.length > 0, structuredOutputs: request.outputSchema !== undefined && request.outputMode !== 'prompt_json' });
  if (Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools, outputSchema: request.outputSchema }), 'utf8') > request.limits.maxInputBytes) {
    throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'Provider input exceeds the configured byte limit.', retryable: false });
  }
}

export * from './fixture.js';
export * from './openai.js';
export * from './ollama.js';
export * from './openrouter.js';
export * from './schema.js';
