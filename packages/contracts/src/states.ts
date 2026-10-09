import { z } from 'zod';
import { LoomrailError } from './errors.js';

export const runStatusSchema = z.enum(['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'needs_attention']);
export const stepStatusSchema = z.enum(['pending', 'running', 'awaiting_approval', 'succeeded', 'failed', 'skipped', 'cancelled', 'uncertain']);
export type RunStatus = z.infer<typeof runStatusSchema>;
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['awaiting_approval', 'succeeded', 'failed', 'cancelled', 'needs_attention'],
  awaiting_approval: ['queued', 'failed', 'cancelled'],
  needs_attention: ['queued', 'failed', 'cancelled'],
  succeeded: [], failed: [], cancelled: [],
};
export const stepTransitions: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ['running', 'skipped', 'cancelled'],
  running: ['awaiting_approval', 'succeeded', 'failed', 'cancelled', 'uncertain'],
  awaiting_approval: ['pending', 'failed', 'cancelled'],
  uncertain: ['succeeded', 'failed', 'cancelled'],
  succeeded: [], failed: [], skipped: [], cancelled: [],
};

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!runTransitions[from].includes(to)) {
    throw new LoomrailError({ code: 'INVALID_TRANSITION', message: `Run cannot move from ${from} to ${to}.`, retryable: false });
  }
}
export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!stepTransitions[from].includes(to)) {
    throw new LoomrailError({ code: 'INVALID_TRANSITION', message: `Step cannot move from ${from} to ${to}.`, retryable: false });
  }
}
