import { describe, expect, it } from 'vitest';
import { generationRequestSchema, generationResponseSchema, type ProviderCapabilities } from '@loomrail/contracts';
import { assertCapabilities, assertProviderRequest } from '../src/index.js';

const capabilities: ProviderCapabilities = { toolCalls: false, structuredOutputs: false, streaming: false, embeddings: false, usageReporting: false };
const request = () => generationRequestSchema.parse({
  schemaVersion: 1, model: { provider: 'fixture', model: 'catalogue-v1', revision: '1', mode: 'fixture' },
  messages: [{ role: 'user', content: 'Example request' }], tools: [],
  settings: { temperature: 0, maxOutputTokens: 100 }, limits: { maxInputBytes: 1000, maxToolCalls: 0, timeoutMs: 1000 },
});

describe('provider boundary', () => {
  it('rejects required unsupported capabilities instead of silently downgrading', () => {
    for (const key of Object.keys(capabilities)) expect(() => assertCapabilities(capabilities, { [key]: true })).toThrow('does not support');
    expect(() => assertCapabilities(capabilities, {})).not.toThrow();
  });
  it('allows fixture requests without a key or remote opt-in', () => {
    expect(() => assertProviderRequest({ id: 'fixture', capabilities }, request(), false)).not.toThrow();
  });
  it('requires explicit remote opt-in', () => {
    const value = request(); value.model.mode = 'remote';
    expect(() => assertProviderRequest({ id: 'fixture', capabilities }, value, false)).toThrow('explicit operator');
  });
  it('rejects mismatched provider identities', () => {
    expect(() => assertProviderRequest({ id: 'other', capabilities }, request(), true)).toThrow('does not match');
  });
  it('counts tool definitions and structured-output schemas against input allowance', () => {
    const value = request(); value.limits.maxInputBytes = 10;
    expect(() => assertProviderRequest({ id: 'fixture', capabilities }, value, false)).toThrow('byte limit');
  });
  it('rejects negative limits and credential fields in normalized requests', () => {
    const value = request(); value.limits.timeoutMs = -1;
    expect(generationRequestSchema.safeParse(value).success).toBe(false);
    expect(generationRequestSchema.safeParse({ ...request(), apiKey: 'not-a-real-secret' }).success).toBe(false);
  });
  it('keeps unknown usage and cost null', () => {
    const response = generationResponseSchema.parse({
      schemaVersion: 1, model: request().model, content: 'Example', toolCalls: [],
      usage: { inputTokens: null, outputTokens: null, estimatedCostUsd: null }, finishReason: 'completed',
    });
    expect(response.usage.estimatedCostUsd).toBeNull();
  });
});
