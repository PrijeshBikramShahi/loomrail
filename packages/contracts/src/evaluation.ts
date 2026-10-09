import { z } from 'zod';
import { idSchema, jsonObjectSchema, jsonValueSchema } from './graph.js';
import { runStatusSchema, stepStatusSchema } from './states.js';
import { errorCodeSchema } from './errors.js';
export const evaluationAssertionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status'), value: runStatusSchema }),
  z.strictObject({ kind: z.literal('error'), value: errorCodeSchema }),
  z.strictObject({ kind: z.literal('result_equals'), path: z.array(z.string()).max(20), value: jsonValueSchema }),
  z.strictObject({ kind: z.literal('result_includes'), path: z.array(z.string()).max(20), value: jsonValueSchema }),
  z.strictObject({ kind: z.literal('step_status'), nodeId: idSchema, value: stepStatusSchema }),
  z.strictObject({ kind: z.literal('instructions_include'), value: z.string().min(1).max(1000) }),
  z.strictObject({ kind: z.literal('valid_sources') }),
  z.strictObject({ kind: z.literal('no_actions') }),
]);
export const evaluationCaseSchema = z.strictObject({ schemaVersion: z.literal(1), name: z.string().min(1).max(120), input: jsonObjectSchema, records: z.array(jsonObjectSchema).max(20), fixtureModel: z.enum(['catalogue-v1','tool-demo-v1','conflict-v1','echo-v1','malformed-v1','unavailable-v1','quota-v1','unauthorized-v1','timeout-v1','limit-v1','loop-v1']), approval: z.enum(['approve','reject','pause']), assertions: z.array(evaluationAssertionSchema).min(1).max(30) });
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export const evaluationRequestSchema = z.strictObject({ candidateVersionId: idSchema, currentVersionId: idSchema.optional(), caseIds: z.array(idSchema).min(1).max(100) });
