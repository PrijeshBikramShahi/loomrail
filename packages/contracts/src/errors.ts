import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'INVALID_GRAPH', 'INVALID_INPUT', 'MISSING_VALUE', 'INVALID_TRANSITION',
  'CAPABILITY_UNSUPPORTED', 'PROVIDER_UNAVAILABLE', 'QUOTA_EXCEEDED', 'INVALID_OUTPUT',
  'TOOL_NOT_ALLOWED', 'LIMIT_EXCEEDED', 'CANCELLED', 'TIMEOUT', 'ACTION_UNCERTAIN', 'INTERNAL_ERROR',
]);
export const executionErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().min(1),
  nodeId: z.string().optional(),
  retryable: z.boolean(),
});
export type ExecutionError = z.infer<typeof executionErrorSchema>;

export class LoomrailError extends Error {
  readonly details: ExecutionError;
  constructor(details: ExecutionError) {
    super(details.message);
    this.name = 'LoomrailError';
    this.details = executionErrorSchema.parse(details);
  }
}
