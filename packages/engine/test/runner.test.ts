import { describe, expect, it } from 'vitest';
import { sampleCatalogueGraph, sampleCatalogueInput } from '@loomrail/contracts';
import { executeDeterministicGraph } from '../src/index.js';

describe('deterministic reference runner', () => {
  it.each([
    [24, 'ready_for_drafting', 'review'], [0, 'needs_price_review', 'ready'], [-5, 'needs_price_review', 'ready'],
  ])('routes price %s and skips the unused branch', (price, status, skipped) => {
    const result = executeDeterministicGraph(sampleCatalogueGraph, { ...sampleCatalogueInput, price });
    expect(result.status).toBe('succeeded');
    expect(result.output).toMatchObject({ status });
    expect(result.steps.find(step => step.nodeId === skipped)?.status).toBe('skipped');
  });
  it('returns a useful node-level error for missing input', () => {
    const result = executeDeterministicGraph(sampleCatalogueGraph, { sku: 'DEMO-001', name: 'Example' });
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'MISSING_VALUE', nodeId: 'prepare' });
    expect(result.steps.find(step => step.nodeId === 'prepare')?.status).toBe('failed');
    expect(result.steps.find(step => step.nodeId === 'check_price')?.status).toBe('skipped');
  });
  it('does not coerce text prices to numbers', () => {
    const result = executeDeterministicGraph(sampleCatalogueGraph, { ...sampleCatalogueInput, price: '24' });
    expect(result.error).toMatchObject({ code: 'INVALID_INPUT', nodeId: 'check_price' });
  });
  it('rejects invalid graphs before executing', () => {
    expect(() => executeDeterministicGraph({ ...sampleCatalogueGraph, edges: [] }, sampleCatalogueInput)).toThrow();
  });
  it('cancels before starting work', () => {
    const result = executeDeterministicGraph(sampleCatalogueGraph, sampleCatalogueInput, AbortSignal.abort());
    expect(result.status).toBe('cancelled');
    expect(result.steps.every(step => step.status === 'cancelled')).toBe(true);
  });
  it('preserves graph and input objects and does not share result objects', () => {
    const graph = structuredClone(sampleCatalogueGraph);
    const input = structuredClone(sampleCatalogueInput);
    const result = executeDeterministicGraph(graph, input);
    expect(graph).toEqual(sampleCatalogueGraph);
    expect(input).toEqual(sampleCatalogueInput);
    const triggerOutput = result.steps[0]!.output as Record<string, unknown>;
    triggerOutput.sku = 'CHANGED';
    expect(input.sku).toBe('DEMO-001');
    expect(result.output).toMatchObject({ listing: { sku: 'DEMO-001' } });
  });
  it('bounds input size', () => {
    expect(() => executeDeterministicGraph(sampleCatalogueGraph, { text: 'x'.repeat(1_000_001) })).toThrow('1 MB');
  });
  it('exists treats missing/null as absent and false/zero as present', () => {
    const graph = structuredClone(sampleCatalogueGraph);
    graph.nodes[2] = { id: 'check_price', name: 'Check optional field', type: 'condition', config: { operator: 'exists', left: { source: 'input', path: ['optional'] } } };
    for (const optional of [null, false, 0]) {
      const result = executeDeterministicGraph(graph, { ...sampleCatalogueInput, optional });
      expect(result.output).toMatchObject({ status: optional === null ? 'needs_price_review' : 'ready_for_drafting' });
    }
    expect(executeDeterministicGraph(graph, sampleCatalogueInput).output).toMatchObject({ status: 'needs_price_review' });
  });
});
