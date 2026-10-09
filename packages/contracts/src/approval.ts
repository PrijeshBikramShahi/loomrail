import { z } from 'zod';
import { idSchema, jsonObjectSchema, type JsonValue } from './graph.js';
function reviewable(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.every(reviewable);
  if (value && typeof value === 'object') return Object.entries(value).every(([key, item]) => !/password|secret|authorization|cookie|token|api.?key|^(__proto__|prototype|constructor)$/i.test(key) && reviewable(item));
  return true;
}
export const proposedUpdateSchema = z.strictObject({ sku: z.string().min(1).max(120), expectedRevision: z.number().int().positive(), changes: jsonObjectSchema.refine(value => reviewable(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => !['__proto__', 'prototype', 'constructor', 'sku'].includes(key)), 'Changes must contain reviewable non-credential fields and cannot change the SKU') });
export const approvalSchema = z.strictObject({ id: idSchema, runId: idSchema, nodeId: idSchema, destination: z.string().default('records'), revision: z.number().int().positive(), status: z.enum(['pending', 'approved', 'rejected', 'applied', 'cancelled']), payload: proposedUpdateSchema, original: jsonObjectSchema, createdAt: z.iso.datetime(), decidedAt: z.iso.datetime().nullable(), operator: z.literal('operator').nullable() });
export const decisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.enum(['approve', 'reject']), revision: z.number().int().positive() }),
  z.strictObject({ decision: z.literal('edit'), revision: z.number().int().positive(), payload: proposedUpdateSchema }),
]);
export type Approval = z.infer<typeof approvalSchema>;
