import { z } from 'zod';
import { executionErrorSchema } from './errors.js';
import { idSchema, jsonObjectSchema, jsonValueSchema, workflowGraphSchema } from './graph.js';
import { executionModeSchema } from './provider.js';
import { runStatusSchema, stepStatusSchema } from './states.js';

export const runSchema = z.strictObject({
  schemaVersion: z.literal(1), id: idSchema, workflowVersionId: idSchema,
  status: runStatusSchema, mode: executionModeSchema, input: jsonObjectSchema,
  cancellationRequested: z.boolean(), createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(),
  result: jsonValueSchema.nullable(), error: executionErrorSchema.nullable(),
});
export const stepRunSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: idSchema, nodeId: idSchema,
  attempt: z.number().int().positive(), status: stepStatusSchema,
  resolvedInputs: jsonValueSchema.nullable(), output: jsonValueSchema.nullable(),
  startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(), error: executionErrorSchema.nullable(),
});
export const runEventSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: idSchema, sequence: z.number().int().positive(), createdAt: z.iso.datetime(),
  type: z.enum(['action_uncertain', 'action_reconciled', 'approval_requested', 'approval_edited', 'approval_decided', 'action_applied', 'model_requested', 'model_responded', 'tool_completed', 'run_queued', 'run_started', 'run_resumed', 'cancellation_requested', 'step_started', 'step_succeeded', 'step_failed', 'step_skipped', 'run_succeeded', 'run_failed', 'run_cancelled']),
  nodeId: idSchema.optional(),
  // Event producers must redact before persistence. Arbitrary provider data is not safe here.
  payload: jsonObjectSchema,
});
export type Run = z.infer<typeof runSchema>;
export type StepRun = z.infer<typeof stepRunSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;

export const createRunSchema = z.strictObject({ workflowVersionId: idSchema, requestId: z.uuid(), input: jsonObjectSchema });
export const runDetailSchema = z.strictObject({ run: runSchema, steps: z.array(stepRunSchema), events: z.array(runEventSchema), graph: workflowGraphSchema, agents: z.array(jsonObjectSchema).default([]) });
export type RunDetail = z.infer<typeof runDetailSchema>;
