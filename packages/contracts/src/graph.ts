import { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export const idSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const safeKey = z.string().min(1).max(120).refine(key => !['__proto__', 'prototype', 'constructor'].includes(key), 'Unsafe object key');
const pathSchema = z.array(safeKey).max(20);

export const bindingSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('literal'), value: jsonValueSchema }),
  z.strictObject({ source: z.literal('input'), path: pathSchema }),
  z.strictObject({ source: z.literal('step'), nodeId: idSchema, path: pathSchema }),
]);
export type Binding = z.infer<typeof bindingSchema>;
const fieldsSchema = z.record(safeKey, bindingSchema).refine(fields => Object.keys(fields).length <= 100, 'At most 100 fields are supported');
const base = { id: idSchema, name: z.string().min(1).max(120) };

export const nodeSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('manual_trigger'), config: z.strictObject({}) }),
  z.strictObject({ ...base, type: z.literal('mapping'), config: z.strictObject({ fields: fieldsSchema }) }),
  z.strictObject({ ...base, type: z.literal('condition'), config: z.discriminatedUnion('operator', [
    z.strictObject({ operator: z.literal('exists'), left: bindingSchema }),
    z.strictObject({ operator: z.enum(['equals', 'not_equals', 'greater_than']), left: bindingSchema, right: bindingSchema }),
  ]) }),
  z.strictObject({ ...base, type: z.literal('record_update'), config: z.strictObject({ proposal: bindingSchema, destination: z.enum(['records', 'http_fixture']).optional() }) }),
  z.strictObject({ ...base, type: z.literal('agent'), config: z.strictObject({ agentVersionId: idSchema, input: bindingSchema }) }),
  z.strictObject({ ...base, type: z.literal('output'), config: z.strictObject({ fields: fieldsSchema }) }),
]);
export type WorkflowNode = z.infer<typeof nodeSchema>;

export const edgeSchema = z.strictObject({ id: idSchema, source: idSchema, target: idSchema, port: z.enum(['next', 'true', 'false']) });
export const graphShapeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nodes: z.array(nodeSchema).min(2).max(100),
  edges: z.array(edgeSchema).min(1).max(200),
});
export type WorkflowGraph = z.infer<typeof graphShapeSchema>;

function bindingsFor(node: WorkflowNode): Binding[] {
  if (node.type === 'mapping' || node.type === 'output') return Object.values(node.config.fields);
  if (node.type === 'record_update') return [node.config.proposal];
  if (node.type === 'agent') return [node.config.input];
  if (node.type === 'condition') return node.config.operator === 'exists' ? [node.config.left] : [node.config.left, node.config.right];
  return [];
}

export const workflowGraphSchema = graphShapeSchema.superRefine((graph, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path });
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length) issue('Node IDs must be unique', ['nodes']);
  if (new Set(graph.edges.map(edge => edge.id)).size !== graph.edges.length) issue('Edge IDs must be unique', ['edges']);
  const triggers = graph.nodes.filter(node => node.type === 'manual_trigger');
  if (triggers.length !== 1) issue('Exactly one manual trigger is required', ['nodes']);
  if (!graph.nodes.some(node => node.type === 'output')) issue('At least one output is required', ['nodes']);
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, WorkflowGraph['edges']>();
  for (const [index, edge] of graph.edges.entries()) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) issue('Edge references a missing node', ['edges', index]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  for (const [index, node] of graph.nodes.entries()) {
    const parents = incoming.get(node.id) ?? [];
    if (parents.length > 1) issue('Joins and ambiguous fan-in are not supported', ['nodes', index]);
    if (node.type === 'manual_trigger' && parents.length > 0) issue('Manual trigger cannot have incoming edges', ['nodes', index]);
    if (node.type !== 'manual_trigger' && parents.length !== 1) issue('Each non-trigger node requires exactly one incoming edge', ['nodes', index]);
    const ports = (outgoing.get(node.id) ?? []).map(edge => edge.port).sort();
    const expected = node.type === 'condition' ? ['false', 'true'] : node.type === 'output' ? [] : ['next'];
    if (ports.join(',') !== expected.join(',')) issue(`Invalid outgoing ports for ${node.type}; expected ${expected.join(', ') || 'none'}`, ['nodes', index]);
  }

  // Kahn's algorithm checks the whole graph, including disconnected cycles.
  const degrees = new Map(graph.nodes.map(node => [node.id, incoming.get(node.id)?.length ?? 0]));
  const queue = graph.nodes.filter(node => degrees.get(node.id) === 0).map(node => node.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const edge of outgoing.get(id) ?? []) {
      const degree = (degrees.get(edge.target) ?? 0) - 1;
      degrees.set(edge.target, degree);
      if (degree === 0) queue.push(edge.target);
    }
  }
  if (visited !== graph.nodes.length) issue('Cycles are not supported', ['edges']);

  const reachable = new Set<string>();
  const pending = triggers.map(node => node.id);
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id) ?? []) pending.push(edge.target);
  }
  for (const [index, node] of graph.nodes.entries()) {
    if (!reachable.has(node.id)) issue('Node is unreachable from the manual trigger', ['nodes', index]);
    const ancestors = new Set<string>();
    let parent = incoming.get(node.id)?.[0];
    while (parent && !ancestors.has(parent) && parent !== node.id) {
      ancestors.add(parent);
      parent = incoming.get(parent)?.[0];
    }
    for (const binding of bindingsFor(node)) {
      if (binding.source !== 'step') continue;
      if (!nodes.has(binding.nodeId)) issue(`Binding references missing node ${binding.nodeId}`, ['nodes', index, 'config']);
      else if (!ancestors.has(binding.nodeId)) issue(`Binding must reference an upstream ancestor: ${binding.nodeId}`, ['nodes', index, 'config']);
    }
  }
});

export const draftGraphSchema = graphShapeSchema.extend({ nodes: z.array(nodeSchema).max(100), edges: z.array(edgeSchema).max(200) });
export const layoutSchema = z.record(idSchema, z.strictObject({ x: z.number().finite(), y: z.number().finite() }));
// Editor positions are deliberately outside the executable graph. Incomplete drafts may be saved.
export const workflowDraftSchema = z.strictObject({
  schemaVersion: z.literal(1), id: idSchema, name: z.string().min(1).max(120),
  graph: draftGraphSchema,
  layout: layoutSchema,
});
export const workflowVersionSchema = z.strictObject({
  schemaVersion: z.literal(1), id: idSchema, workflowId: idSchema,
  version: z.number().int().positive(), graph: workflowGraphSchema, createdAt: z.iso.datetime(),
});
export const workflowDocumentSchema = workflowDraftSchema.extend({ revision: z.number().int().nonnegative(), publishedVersionId: idSchema.nullable(), publishedVersion: z.number().int().positive().nullable() });
export const saveDraftSchema = workflowDraftSchema.omit({ id: true }).extend({ revision: z.number().int().nonnegative() });
export const publishWorkflowSchema = z.strictObject({ revision: z.number().int().nonnegative() });
export const newWorkflowSchema = z.strictObject({ name: z.string().trim().min(1).max(120) });
export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;

/** Incremental edge check for incomplete editor graphs; full validation still gates publishing. */
export function connectionIssue(graph: WorkflowGraph, edge: WorkflowGraph['edges'][number]): string | null {
  const source = graph.nodes.find(node => node.id === edge.source);
  const target = graph.nodes.find(node => node.id === edge.target);
  if (!source || !target) return 'Both nodes must exist.';
  if (source.id === target.id) return 'A node cannot connect to itself.';
  if (source.type === 'output' || target.type === 'manual_trigger') return 'Outputs end the workflow and manual triggers start it.';
  if (source.type === 'condition' ? !['true', 'false'].includes(edge.port) : edge.port !== 'next') return 'Choose a valid output port.';
  if (graph.edges.some(item => item.id === edge.id || (item.source === edge.source && item.port === edge.port))) return 'This output port already has a connection.';
  if (graph.edges.some(item => item.target === edge.target)) return 'Joins are not supported. This node already has an input.';
  const pending = [target.id]; const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source.id) return 'This connection would create a cycle.';
    if (visited.has(id)) continue;
    visited.add(id); pending.push(...graph.edges.filter(item => item.source === id).map(item => item.target));
  }
  return null;
}
