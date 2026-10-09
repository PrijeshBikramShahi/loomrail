import { z } from 'zod';
import { jsonObjectSchema, jsonValueSchema } from './graph.js';

export const executionModeSchema = z.enum(['fixture', 'local', 'remote']);
export const providerCapabilitiesSchema = z.strictObject({
  toolCalls: z.boolean(), structuredOutputs: z.boolean(), streaming: z.boolean(), embeddings: z.boolean(), usageReporting: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;
export const modelIdentitySchema = z.strictObject({
  provider: z.string().min(1), model: z.string().min(1), revision: z.string().min(1).optional(), mode: executionModeSchema,
});
export const toolRequestSchema = z.strictObject({ id: z.string().min(1), name: z.string().min(1), arguments: jsonObjectSchema });
export const providerMessageSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.enum(['system', 'user']), content: z.string() }),
  z.strictObject({ role: z.literal('assistant'), content: z.string(), toolCalls: z.array(toolRequestSchema) }),
  z.strictObject({ role: z.literal('tool'), toolCallId: z.string().min(1), content: jsonValueSchema }),
]);
export const generationRequestSchema = z.strictObject({
  schemaVersion: z.literal(1), model: modelIdentitySchema,
  messages: z.array(providerMessageSchema).min(1).max(100),
  tools: z.array(z.strictObject({ name: z.string().min(1), description: z.string(), inputSchema: jsonObjectSchema })).max(20),
  outputSchema: jsonObjectSchema.optional(),
  outputMode: z.enum(['native_schema', 'prompt_json']).optional(),
  settings: z.strictObject({ temperature: z.number().min(0).max(2), maxOutputTokens: z.number().int().min(1).max(32768) }),
  limits: z.strictObject({ maxInputBytes: z.number().int().min(1).max(1_000_000), maxToolCalls: z.number().int().min(0).max(50), timeoutMs: z.number().int().min(1).max(300_000) }),
});
export const generationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1), model: modelIdentitySchema, content: z.string(),
  structuredOutput: jsonValueSchema.optional(), toolCalls: z.array(toolRequestSchema),
  usage: z.strictObject({ inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(), estimatedCostUsd: z.number().nonnegative().nullable() }),
  finishReason: z.enum(['completed', 'tool_calls', 'output_limit']),
});
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type GenerationResponse = z.infer<typeof generationResponseSchema>;
export interface Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  generate(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationResponse>;
}

/** Explicitly supported free endpoints; capability changes require revalidation. */
export const openRouterModels = [
  { id: 'poolside/laguna-s-2.1:free', label: 'Laguna S 2.1 (free)', outputMode: 'prompt_json' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super (free)', outputMode: 'native_schema' },
] as const;
