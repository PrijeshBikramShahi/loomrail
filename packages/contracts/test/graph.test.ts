import { describe, expect, it } from 'vitest';
import { sampleCatalogueGraph, workflowGraphSchema, workflowDraftSchema } from '../src/index.js';

const graph = () => structuredClone(sampleCatalogueGraph);
const errors = (value: unknown) => {
  const result = workflowGraphSchema.safeParse(value);
  expect(result.success).toBe(false);
  return result.success ? '' : result.error.issues.map(issue => issue.message).join('; ');
};

describe('workflow contracts', () => {
  it('accepts the versioned sample graph', () => { expect(workflowGraphSchema.parse(graph())).toEqual(graph()); });
  it('rejects missing edge references', () => {
    const value = graph(); value.edges[0]!.target = 'missing';
    expect(errors(value)).toContain('missing node');
  });
  it('rejects malformed node configuration', () => {
    const value = graph(); Object.assign(value.nodes[2]!.config, { operator: 'execute_shell' });
    errors(value);
  });
  it('rejects unknown config keys', () => {
    const value = graph(); Object.assign(value.nodes[0]!.config, { command: 'echo example' });
    errors(value);
  });
  it('rejects cycles even in a disconnected component', () => {
    const value = graph();
    value.nodes.push({ id: 'a', name: 'A', type: 'mapping', config: { fields: {} } }, { id: 'b', name: 'B', type: 'mapping', config: { fields: {} } });
    value.edges.push({ id: 'a_b', source: 'a', target: 'b', port: 'next' }, { id: 'b_a', source: 'b', target: 'a', port: 'next' });
    expect(errors(value)).toContain('Cycles');
    expect(errors(value)).toContain('unreachable');
  });
  it('rejects branch joins', () => {
    const value = graph(); value.edges[3]!.target = 'ready';
    expect(errors(value)).toContain('fan-in');
  });
  it.each(['nodes', 'edges'] as const)('rejects duplicate %s IDs', collection => {
    const value = graph(); value[collection][1]!.id = value[collection][0]!.id;
    expect(errors(value)).toContain('unique');
  });
  it('requires exactly one entry point', () => {
    const value = graph(); value.nodes.push({ id: 'other_start', name: 'Other', type: 'manual_trigger', config: {} });
    expect(errors(value)).toContain('Exactly one manual trigger');
  });
  it('requires both condition branches', () => {
    const value = graph(); value.edges.pop();
    expect(errors(value)).toContain('outgoing ports');
  });
  it('rejects unsupported parallel fan-out', () => {
    const value = graph(); value.edges.push({ id: 'extra', source: 'start', target: 'review', port: 'next' });
    expect(errors(value)).toContain('outgoing ports');
  });
  it.each(['missing', 'ready', 'review', 'prepare'])('rejects missing, future, sibling, or self binding: %s', nodeId => {
    const value = graph();
    const node = value.nodes.find(item => item.id === 'prepare')!;
    if (node.type !== 'mapping') throw new Error('Wrong test node');
    node.config.fields.bad = { source: 'step', nodeId, path: [] };
    errors(value);
  });
  it('rejects prototype access paths', () => {
    const value = graph(); const node = value.nodes[1]!;
    if (node.type !== 'mapping') throw new Error('Wrong test node');
    node.config.fields.bad = { source: 'input', path: ['__proto__'] };
    expect(errors(value)).toContain('Unsafe object key');
  });
  it('rejects unknown schema versions', () => { errors({ ...graph(), schemaVersion: 2 }); });
  it('keeps layout separate from executable behavior', () => {
    const value = workflowDraftSchema.parse({ schemaVersion: 1, id: 'catalogue', name: 'Catalogue', graph: graph(), layout: { start: { x: 0, y: 0 } } });
    const before = structuredClone(value.graph);
    value.layout.start!.x = 200;
    expect(value.graph).toEqual(before);
    errors({ ...graph(), layout: value.layout });
  });
});
