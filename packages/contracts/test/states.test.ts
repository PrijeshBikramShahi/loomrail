import { describe, expect, it } from 'vitest';
import { assertRunTransition, assertStepTransition, runStatusSchema, stepStatusSchema } from '../src/index.js';

describe('state transitions', () => {
  it('supports queue, execution, approval pause, and resume', () => {
    assertRunTransition('queued', 'running');
    assertRunTransition('running', 'awaiting_approval');
    assertRunTransition('awaiting_approval', 'queued');
    assertStepTransition('awaiting_approval', 'pending');
  });
  it('does not allow an uncertain write to be retried automatically', () => {
    expect(() => assertStepTransition('uncertain', 'pending')).toThrow('cannot move');
    assertStepTransition('uncertain', 'succeeded');
  });
  it.each(['succeeded', 'failed', 'cancelled'] as const)('keeps %s runs terminal', from => {
    for (const to of runStatusSchema.options) expect(() => assertRunTransition(from, to)).toThrow('cannot move');
  });
  it.each(['succeeded', 'failed', 'cancelled', 'skipped'] as const)('keeps %s steps terminal', from => {
    for (const to of stepStatusSchema.options) expect(() => assertStepTransition(from, to)).toThrow('cannot move');
  });
});
