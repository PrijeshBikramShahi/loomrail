import { isDeepStrictEqual } from 'node:util';
import {
  LoomrailError, jsonObjectSchema, workflowGraphSchema,
  type Binding, type ExecutionError, type JsonValue, type StepStatus, type WorkflowNode, type WorkflowGraph,
} from '@loomrail/contracts';

export interface DeterministicStep {
  nodeId: string;
  status: StepStatus;
  output: JsonValue | null;
  error: ExecutionError | null;
}
export interface DeterministicResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  output: JsonValue | null;
  steps: DeterministicStep[];
  error: ExecutionError | null;
}

function resolve(binding: Binding, input: JsonValue, outputs: Map<string, JsonValue>, allowMissing = false): JsonValue | undefined {
  if (binding.source === 'literal') return structuredClone(binding.value);
  let value: JsonValue | undefined = binding.source === 'input' ? input : outputs.get(binding.nodeId);
  for (const key of binding.path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      value = undefined;
      break;
    }
    value = (value as Record<string, JsonValue>)[key];
  }
  if (value === undefined && !allowMissing) {
    throw new LoomrailError({ code: 'MISSING_VALUE', message: `Required ${binding.source} value at ${binding.path.join('.') || '(root)'} is missing.`, retryable: false });
  }
  return value === undefined ? undefined : structuredClone(value);
}

export function resolveDeterministicInputs(node: WorkflowNode, input: JsonValue, outputs: Map<string, JsonValue>): JsonValue {
  if (node.type === 'record_update') return resolve(node.config.proposal, input, outputs)!;
  if (node.type === 'agent') return resolve(node.config.input, input, outputs)!;
  if (node.type === 'manual_trigger') return structuredClone(input);
  if (node.type === 'mapping' || node.type === 'output') {
    return Object.fromEntries(Object.entries(node.config.fields).map(([key, binding]) => [key, resolve(binding, input, outputs)!]));
  }
  const config = node.config;
  return { left: resolve(config.left, input, outputs, config.operator === 'exists') ?? null,
    ...(config.operator === 'exists' ? {} : { right: resolve(config.right, input, outputs)! }) };
}

export function evaluateDeterministicNode(node: WorkflowNode, resolvedInputs: JsonValue): JsonValue {
  if (node.type === 'agent' || node.type === 'record_update') throw new LoomrailError({ code: 'CAPABILITY_UNSUPPORTED', message: 'Agent nodes require the persisted asynchronous worker.', retryable: false });
  if (node.type !== 'condition') return structuredClone(resolvedInputs);
  const config = node.config;
  const inputs = resolvedInputs as Record<string, JsonValue>;
  const left = inputs.left;
  const right = inputs.right;
  if (config.operator === 'exists') return left !== undefined && left !== null;
  if (config.operator === 'equals') return isDeepStrictEqual(left, right);
  if (config.operator === 'not_equals') return !isDeepStrictEqual(left, right);
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new LoomrailError({ code: 'INVALID_INPUT', message: 'greater_than requires two finite numbers; no string coercion is performed.', retryable: false });
  }
  return left > right;
}

/** M0 reference evaluator: no persistence, tools, models, network, or resume semantics. */
export function executeDeterministicGraph(graphValue: unknown, inputValue: unknown, signal?: AbortSignal): DeterministicResult {
  const parsedGraph = workflowGraphSchema.safeParse(graphValue);
  if (!parsedGraph.success) throw new LoomrailError({ code: 'INVALID_GRAPH', message: parsedGraph.error.issues.map(issue => issue.message).join('; '), retryable: false });
  const parsedInput = jsonObjectSchema.safeParse(inputValue);
  if (!parsedInput.success) throw new LoomrailError({ code: 'INVALID_INPUT', message: 'Run input must be a JSON object.', retryable: false });
  if (Buffer.byteLength(JSON.stringify(parsedInput.data), 'utf8') > 1_000_000) {
    throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'Run input exceeds 1 MB.', retryable: false });
  }
  const graph = parsedGraph.data;
  const outputs = new Map<string, JsonValue>();
  const steps: DeterministicStep[] = graph.nodes.map(node => ({ nodeId: node.id, status: 'pending', output: null, error: null }));
  const finishPending = (status: StepStatus) => { for (const step of steps) if (step.status === 'pending') step.status = status; };
  let current: WorkflowNode | undefined = graph.nodes.find(node => node.type === 'manual_trigger');
  while (current) {
    const node: WorkflowNode = current;
    if (signal?.aborted) {
      finishPending('cancelled');
      return { status: 'cancelled', output: null, steps, error: { code: 'CANCELLED', message: 'Execution was cancelled.', retryable: false } };
    }
    const step = steps.find(item => item.nodeId === node.id)!;
    step.status = 'running';
    try {
      const output = evaluateDeterministicNode(node, resolveDeterministicInputs(node, parsedInput.data, outputs));
      if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 1_000_000) {
        throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'Step output exceeds 1 MB.', retryable: false });
      }
      outputs.set(node.id, output);
      step.status = 'succeeded';
      step.output = output;
      if (node.type === 'output') {
        finishPending('skipped');
        return { status: 'succeeded', output, steps, error: null };
      }
      const port = node.type === 'condition' ? (output ? 'true' : 'false') : 'next';
      const edge: WorkflowGraph['edges'][number] = graph.edges.find(item => item.source === node.id && item.port === port)!;
      current = graph.nodes.find(node => node.id === edge.target);
    } catch (error) {
      const details: ExecutionError = error instanceof LoomrailError
        ? { ...error.details, nodeId: node.id }
        : { code: 'INTERNAL_ERROR', message: 'Step execution failed.', retryable: false, nodeId: node.id };
      step.status = 'failed';
      step.error = details;
      finishPending('skipped');
      return { status: 'failed', output: null, steps, error: details };
    }
  }
  throw new LoomrailError({ code: 'INTERNAL_ERROR', message: 'Validated graph ended without an output.', retryable: false });
}
