import { LoomrailError, type GenerationRequest } from '@loomrail/contracts';

export type Fetcher = typeof fetch;
export async function boundedJson(url: string, body: unknown, request: GenerationRequest, signal: AbortSignal | undefined, fetcher: Fetcher, headers: Record<string, string> = {}): Promise<unknown> {
  const deadline = AbortSignal.timeout(request.limits.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetcher(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: combined });
    if (!response.ok) {
      await response.body?.cancel();
      throw new LoomrailError({ code: response.status === 429 ? 'QUOTA_EXCEEDED' : response.status === 400 ? 'INVALID_INPUT' : 'PROVIDER_UNAVAILABLE', message: response.status === 429 ? 'Provider quota or rate limit was exhausted.' : `Provider rejected the request (HTTP ${response.status}). Check the configured model, capabilities, and credentials.`, retryable: response.status >= 500 });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty response');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1_000_000) { await reader.cancel(); throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'Provider response exceeded 1 MB.', retryable: false }); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new LoomrailError({ code: 'INVALID_OUTPUT', message: 'Provider returned malformed JSON.', retryable: false }); }
  } catch (error) {
    if (error instanceof LoomrailError) throw error;
    if (signal?.aborted) throw new LoomrailError({ code: 'CANCELLED', message: 'Provider request was cancelled.', retryable: false });
    if (deadline.aborted) throw new LoomrailError({ code: 'TIMEOUT', message: 'Provider request timed out.', retryable: true });
    throw new LoomrailError({ code: 'PROVIDER_UNAVAILABLE', message: 'Provider could not be reached. No fallback provider was used.', retryable: true });
  }
}
export function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
