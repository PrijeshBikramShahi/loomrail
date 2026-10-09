import { expect, it } from 'vitest';
import { connectionIssue, draftGraphSchema, sampleCatalogueGraph } from '../src/index.js';

it('accepts incomplete drafts without accepting them as runnable graphs', () => {
  expect(draftGraphSchema.parse({ schemaVersion: 1, nodes: [], edges: [] }).nodes).toEqual([]);
});
it('accepts one valid incremental connection', () => {
  const graph = structuredClone(sampleCatalogueGraph); graph.edges = [];
  expect(connectionIssue(graph, { id: 'new', source: 'start', target: 'prepare', port: 'next' })).toBeNull();
});
it('rejects duplicate ports, joins, cycles, incompatible ports and missing nodes', () => {
  const graph = structuredClone(sampleCatalogueGraph);
  expect(connectionIssue(graph, { id: 'new', source: 'start', target: 'review', port: 'next' })).toContain('already');
  expect(connectionIssue(graph, { id: 'new', source: 'ready', target: 'start', port: 'next' })).toContain('Outputs');
  expect(connectionIssue(graph, { id: 'new', source: 'missing', target: 'prepare', port: 'next' })).toContain('exist');
  expect(connectionIssue(graph, { id: 'new', source: 'check_price', target: 'ready', port: 'next' })).toContain('valid output');
  graph.edges = [{ id: 'one', source: 'prepare', target: 'check_price', port: 'next' }];
  expect(connectionIssue(graph, { id: 'new', source: 'check_price', target: 'prepare', port: 'true' })).toContain('cycle');
  expect(connectionIssue(graph, { id: 'new', source: 'start', target: 'check_price', port: 'next' })).toContain('Joins');
});
