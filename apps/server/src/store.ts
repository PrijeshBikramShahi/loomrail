import { fixtureEndpoint, prepareExternal, type ExternalAttempt } from './external.js';
import { ApprovalStore } from './approvals.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  createRunSchema, workflowGraphSchema, runSchema, stepRunSchema, runEventSchema, LoomrailError,
  workflowDocumentSchema, saveDraftSchema, publishWorkflowSchema, newWorkflowSchema, workflowVersionSchema,
  sampleCatalogueGraph, type Run, type StepRun, type RunEvent, type WorkflowGraph, type JsonValue, type ExecutionError, type Approval,
} from '@loomrail/contracts';
import { AgentStore, type AgentExecution } from './agents.js';
import { evaluateDeterministicNode, resolveDeterministicInputs } from '@loomrail/engine';

export class StoreError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
interface RunRow { id: string; workflow_version_id: string; request_id: string; status: string; next_node: string | null; owner: string | null; data_json: string }
export const LEASE_MS = 10_000;

export class RunStore {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private timestamp() { return new Date(this.now()).toISOString(); }
  private row(id: string): RunRow {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
    if (!row) throw new StoreError(404, 'Run not found.');
    return row;
  }
  private save(run: Run) {
    runSchema.parse(run);
    this.db.prepare('UPDATE runs SET status = ?, data_json = ? WHERE id = ?').run(run.status, JSON.stringify(run), run.id);
  }
  private saveStep(step: StepRun) {
    stepRunSchema.parse(step);
    this.db.prepare('UPDATE step_runs SET data_json = ? WHERE run_id = ? AND node_id = ?').run(JSON.stringify(step), step.runId, step.nodeId);
  }
  private event(runId: string, type: RunEvent['type'], nodeId?: string, payload: RunEvent['payload'] = {}) {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_events WHERE run_id = ?').get(runId)!;
    // Call only inside an IMMEDIATE transaction. Payloads contain metadata, never input/output values.
    const event = runEventSchema.parse({ schemaVersion: 1, runId, sequence: Number(row.next), type, createdAt: this.timestamp(), ...(nodeId ? { nodeId } : {}), payload });
    this.db.prepare('INSERT INTO run_events VALUES (?, ?, ?)').run(runId, event.sequence, JSON.stringify(event));
  }
  seedSample() {
    this.transaction(() => {
      if (this.db.prepare("SELECT id FROM workflows WHERE id = 'catalogue'").get()) return;
      const timestamp = this.timestamp();
      this.db.prepare('INSERT INTO workflows (id,name,schema_version,draft_json,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run('catalogue', 'Supplier catalogue', 1, JSON.stringify(sampleCatalogueGraph), timestamp, timestamp);
      this.db.prepare('INSERT INTO workflow_versions VALUES (?,?,?,?,?,?)')
        .run('catalogue-v1', 'catalogue', 1, 1, JSON.stringify(sampleCatalogueGraph), timestamp);
      this.db.prepare("UPDATE workflows SET published_version_id = 'catalogue-v1' WHERE id = 'catalogue'").run();
    });
  }
  workflows() {
    return this.db.prepare('SELECT w.id, w.name, w.published_version_id AS publishedVersionId, v.version AS publishedVersion FROM workflows w LEFT JOIN workflow_versions v ON v.id = w.published_version_id ORDER BY w.name').all();
  }
  workflow(id: string) {
    const row = this.db.prepare('SELECT w.*, v.version AS published_version FROM workflows w LEFT JOIN workflow_versions v ON v.id = w.published_version_id WHERE w.id = ?').get(id);
    if (!row) throw new StoreError(404, 'Workflow not found.');
    return workflowDocumentSchema.parse({ schemaVersion: 1, id: row.id, name: row.name, graph: JSON.parse(String(row.draft_json)), layout: JSON.parse(String(row.layout_json)), revision: row.draft_revision, publishedVersionId: row.published_version_id, publishedVersion: row.published_version });
  }
  createWorkflow(value: unknown) {
    const { name } = newWorkflowSchema.parse(value);
    const id = `workflow_${randomUUID()}`;
    const timestamp = this.timestamp();
    this.db.prepare('INSERT INTO workflows (id, name, schema_version, draft_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)')
      .run(id, name, JSON.stringify({ schemaVersion: 1, nodes: [], edges: [] }), timestamp, timestamp);
    return this.workflow(id);
  }
  saveDraft(id: string, value: unknown) {
    const draft = saveDraftSchema.parse(value);
    return this.transaction(() => {
      const current = this.workflow(id);
      if (current.revision !== draft.revision) throw new StoreError(409, 'This draft changed in another tab. Reopen it before saving.');
      this.db.prepare('UPDATE workflows SET name = ?, draft_json = ?, layout_json = ?, updated_at = ?, draft_revision = draft_revision + 1 WHERE id = ?')
        .run(draft.name, JSON.stringify(draft.graph), JSON.stringify(draft.layout), this.timestamp(), id);
      return this.workflow(id);
    });
  }
  publish(id: string, value: unknown) {
    const { revision } = publishWorkflowSchema.parse(value);
    return this.transaction(() => {
      const draft = this.workflow(id);
      if (draft.revision !== revision) throw new StoreError(409, 'The draft changed before publishing. Reopen it and try again.');
      const parsed = workflowGraphSchema.safeParse(draft.graph);
      if (!parsed.success) throw new StoreError(400, parsed.error.issues.map(issue => issue.message).join('; '));
      for (const node of parsed.data.nodes) if (node.type === 'agent') new AgentStore(this).get(node.config.agentVersionId);
      const next = Number(this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM workflow_versions WHERE workflow_id = ?').get(id)!.next);
      const version = workflowVersionSchema.parse({ schemaVersion: 1, id: randomUUID(), workflowId: id, version: next, graph: parsed.data, createdAt: this.timestamp() });
      this.db.prepare('INSERT INTO workflow_versions VALUES (?, ?, ?, ?, ?, ?)').run(version.id, id, version.version, 1, JSON.stringify(version.graph), version.createdAt);
      this.db.prepare('UPDATE workflows SET published_version_id = ?, updated_at = ?, draft_revision = draft_revision + 1 WHERE id = ?').run(version.id, version.createdAt, id);
      return { workflow: this.workflow(id), version };
    });
  }
  graph(versionId: string): WorkflowGraph {
    const row = this.db.prepare('SELECT graph_json FROM workflow_versions WHERE id = ?').get(versionId);
    if (!row) throw new StoreError(404, 'Published workflow version not found.');
    return workflowGraphSchema.parse(JSON.parse(String(row.graph_json)));
  }
  create(value: unknown): Run {
    const request = createRunSchema.parse(value);
    if (Buffer.byteLength(JSON.stringify(request.input)) > 1_000_000) throw new StoreError(413, 'Run input exceeds 1 MB.');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT data_json FROM runs WHERE request_id = ?').get(request.requestId);
      if (existing) {
        const run = runSchema.parse(JSON.parse(String(existing.data_json)));
        if (run.workflowVersionId !== request.workflowVersionId || JSON.stringify(run.input) !== JSON.stringify(request.input)) throw new StoreError(409, 'This request ID was already used with different input.');
        return run;
      }
      const graph = this.graph(request.workflowVersionId);
      const modes = graph.nodes.flatMap(node => node.type === 'agent' ? [new AgentStore(this).get(node.config.agentVersionId).definition.model.mode] : []);
      const run: Run = { schemaVersion: 1, id: randomUUID(), workflowVersionId: request.workflowVersionId, status: 'queued', mode: modes.includes('remote') ? 'remote' : modes.includes('local') ? 'local' : 'fixture', input: request.input,
        cancellationRequested: false, createdAt: this.timestamp(), startedAt: null, finishedAt: null, result: null, error: null };
      this.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, NULL, ?)')
        .run(run.id, run.workflowVersionId, request.requestId, run.status, graph.nodes.find(node => node.type === 'manual_trigger')!.id, JSON.stringify(run));
      for (const node of graph.nodes) {
        const step: StepRun = { schemaVersion: 1, runId: run.id, nodeId: node.id, attempt: 1, status: 'pending', resolvedInputs: null, output: null, startedAt: null, finishedAt: null, error: null };
        this.db.prepare('INSERT INTO step_runs VALUES (?, ?, ?)').run(run.id, node.id, JSON.stringify(step));
      }
      this.event(run.id, 'run_queued');
      return run;
    });
  }
  list(limit = 50): Run[] {
    return this.db.prepare('SELECT data_json FROM runs ORDER BY rowid DESC LIMIT ?').all(limit).map(row => runSchema.parse(JSON.parse(String(row.data_json))));
  }
  get(id: string): Run { return runSchema.parse(JSON.parse(this.row(id).data_json)); }
  steps(id: string): StepRun[] {
    return this.db.prepare('SELECT data_json FROM step_runs WHERE run_id = ? ORDER BY rowid').all(id).map(row => stepRunSchema.parse(JSON.parse(String(row.data_json))));
  }
  events(id: string, after = 0): RunEvent[] {
    this.row(id);
    return this.db.prepare('SELECT data_json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 1000').all(id, after).map(row => runEventSchema.parse(JSON.parse(String(row.data_json))));
  }
  detail(id: string) {
    // A read transaction gives the UI one coherent snapshot while the worker commits steps.
    this.db.exec('BEGIN');
    try { const run = this.get(id); const detail = { run, graph: this.graph(run.workflowVersionId), steps: this.steps(id), events: this.events(id), agents: this.db.prepare('SELECT node_id AS nodeId,data_json FROM agent_executions WHERE run_id=?').all(id).map(row => ({ nodeId: String(row.nodeId), ...JSON.parse(String(row.data_json)) as AgentExecution })) }; this.db.exec('COMMIT'); return detail; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  cancel(id: string): Run {
    return this.transaction(() => {
      const run = this.get(id);
      if (!['queued', 'running', 'awaiting_approval', 'needs_attention'].includes(run.status) || run.cancellationRequested) return run;
      run.cancellationRequested = true;
      this.event(id, 'cancellation_requested');
      // Active model requests are aborted by the heartbeat; late results cannot commit.
      for (const approval of new ApprovalStore(this).list().filter(item => item.runId === id && ['pending', 'approved'].includes(item.status))) { approval.status = 'cancelled'; new ApprovalStore(this).save(approval); }
      this.finish(run, 'cancelled');
      return run;
    });
  }
  private finish(run: Run, status: 'succeeded' | 'failed' | 'cancelled') {
    run.status = status; run.finishedAt = this.timestamp();
    for (const step of this.steps(run.id)) {
      if (!['pending', 'running', 'awaiting_approval', 'uncertain'].includes(step.status)) continue;
      step.status = status === 'cancelled' ? 'cancelled' : 'skipped'; step.finishedAt = run.finishedAt;
      this.saveStep(step);
      if (step.status === 'skipped') this.event(run.id, 'step_skipped', step.nodeId);
    }
    this.save(run);
    this.db.prepare('UPDATE runs SET owner = NULL, next_node = NULL WHERE id = ?').run(run.id);
    this.event(run.id, status === 'succeeded' ? 'run_succeeded' : status === 'failed' ? 'run_failed' : 'run_cancelled');
  }
  claim(token: string): string | null {
    return this.transaction(() => {
      const lease = this.db.prepare('SELECT token, expires_at FROM worker_lease WHERE id = 1').get();
      if (lease && lease.token !== token && Number(lease.expires_at) > this.now()) return null;
      this.db.prepare('INSERT INTO worker_lease VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at').run(token, this.now() + LEASE_MS);
      const row = this.db.prepare("SELECT * FROM runs WHERE status IN ('queued','running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, rowid LIMIT 1").get() as unknown as RunRow | undefined;
      if (!row) return null;
      const run = runSchema.parse(JSON.parse(row.data_json));
      if (run.status === 'queued') {
        run.status = 'running'; run.startedAt = this.timestamp(); this.save(run); this.event(run.id, 'run_started');
      } else if (row.owner !== token) this.event(run.id, 'run_resumed');
      this.db.prepare('UPDATE runs SET owner = ? WHERE id = ?').run(token, run.id);
      return run.id;
    });
  }
  advance(id: string, token: string): boolean {
    return this.transaction(() => {
      const lease = this.db.prepare('SELECT token, expires_at FROM worker_lease WHERE id = 1').get();
      if (!lease || lease.token !== token || Number(lease.expires_at) <= this.now()) throw new StoreError(409, 'Worker lease lost.');
      const row = this.row(id);
      if (['succeeded', 'failed', 'cancelled'].includes(row.status)) return false;
      if (row.owner !== token) throw new StoreError(409, 'Run belongs to another worker.');
      const run = runSchema.parse(JSON.parse(row.data_json));
      const graph = this.graph(run.workflowVersionId);
      const node = graph.nodes.find(node => node.id === row.next_node);
      if (!node) throw new Error('Persisted scheduling pointer is invalid.');
      const steps = this.steps(id);
      const step = steps.find(step => step.nodeId === node.id)!;
      if (node.type === 'record_update' && step.status === 'running') { this.markExternalUncertain(id, node.id); return false; }
      if (node.type === 'agent' && step.status === 'running') return true;
      if (step.status !== 'pending') throw new Error('Refusing to execute a completed step.');
      step.status = 'running'; step.startedAt = this.timestamp(); this.event(id, 'step_started', node.id);
      this.db.exec('SAVEPOINT step_evaluation');
      try {
        const outputs = new Map<string, JsonValue>(steps.filter(step => step.status === 'succeeded').map(step => [step.nodeId, step.output]));
        step.resolvedInputs = resolveDeterministicInputs(node, run.input, outputs);
        if (node.type === 'agent') {
          const agent = new AgentStore(this).get(node.config.agentVersionId);
          const state: AgentExecution = { agent, messages: [{ role: 'system', content: agent.definition.instructions }, { role: 'user', content: JSON.stringify(step.resolvedInputs) }], requests: 0, tools: [], responses: [], startedAt: this.now(), pendingResponse: null };
          this.db.prepare('INSERT INTO agent_executions VALUES (?,?,?)').run(id, node.id, JSON.stringify(state));
          this.saveStep(step); this.db.exec('RELEASE step_evaluation'); return true;
        }
        if (node.type === 'record_update') {
          const approvals = new ApprovalStore(this); const approval = approvals.forStep(id, node.id);
          if (!approval) {
            approvals.propose(id, node.id, step.resolvedInputs, node.config.destination === 'http_fixture' ? fixtureEndpoint() : 'records'); step.status = 'awaiting_approval'; this.saveStep(step); run.status = 'awaiting_approval'; this.save(run);
            this.db.prepare('UPDATE runs SET owner=NULL WHERE id=?').run(id); this.event(id, 'approval_requested', node.id); this.db.exec('RELEASE step_evaluation'); return false;
          }
          if (node.config.destination === 'http_fixture') { prepareExternal(this, approval); this.saveStep(step); this.db.exec('RELEASE step_evaluation'); return true; }
          step.output = approvals.apply(approval); this.event(id, 'action_applied', node.id, { actionId: approval.id });
        } else step.output = evaluateDeterministicNode(node, step.resolvedInputs);
        if (Buffer.byteLength(JSON.stringify(step.output)) > 1_000_000) throw new LoomrailError({ code: 'LIMIT_EXCEEDED', message: 'Step output exceeds 1 MB.', retryable: false });
      } catch (error) {
        this.db.exec('ROLLBACK TO step_evaluation'); this.db.exec('RELEASE step_evaluation');
        if (error instanceof Error && 'errcode' in error) throw error;
        step.status = 'failed'; step.finishedAt = this.timestamp(); step.output = null;
        step.error = { ...(error instanceof LoomrailError ? error.details : { code: error instanceof StoreError ? 'INVALID_INPUT' as const : 'INTERNAL_ERROR' as const, message: error instanceof StoreError ? error.message : 'Step evaluation failed.', retryable: false }), nodeId: node.id };
        this.saveStep(step); this.event(id, 'step_failed', node.id, { code: step.error.code });
        run.error = step.error; this.finish(run, 'failed'); return false;
      }
      this.db.exec('RELEASE step_evaluation');
      step.status = 'succeeded'; step.finishedAt = this.timestamp(); this.saveStep(step); this.event(id, 'step_succeeded', node.id);
      if (node.type === 'output') { run.result = step.output; this.finish(run, 'succeeded'); return false; }
      const port = node.type === 'condition' ? (step.output ? 'true' : 'false') : 'next';
      if (node.type === 'condition') {
        const unused = [graph.edges.find(edge => edge.source === node.id && edge.port !== port)!.target];
        while (unused.length) {
          const skippedId = unused.pop()!;
          const skipped = steps.find(item => item.nodeId === skippedId)!;
          skipped.status = 'skipped'; skipped.finishedAt = this.timestamp(); this.saveStep(skipped);
          this.event(id, 'step_skipped', skippedId);
          unused.push(...graph.edges.filter(edge => edge.source === skippedId).map(edge => edge.target));
        }
      }
      const next = graph.edges.find(edge => edge.source === node.id && edge.port === port)!.target;
      this.db.prepare('UPDATE runs SET next_node = ? WHERE id = ?').run(next, id);
      this.db.prepare('UPDATE worker_lease SET expires_at = ? WHERE token = ?').run(this.now() + LEASE_MS, token);
      return true;
    });
  }
  private markExternalUncertain(id: string, nodeId: string) {
    const run = this.get(id); const step = this.steps(id).find(item => item.nodeId === nodeId)!;
    this.db.prepare("UPDATE actions SET status='uncertain' WHERE run_id=? AND kind='http_fixture' AND status='sending'").run(id);
    step.status = 'uncertain'; step.error = { code: 'ACTION_UNCERTAIN', message: 'The external write may have happened. Reconcile its action identity; do not retry blindly.', retryable: false, nodeId }; this.saveStep(step);
    run.status = 'needs_attention'; run.error = step.error; this.save(run); this.db.prepare('UPDATE runs SET owner=NULL WHERE id=?').run(id); this.event(id, 'action_uncertain', nodeId);
  }
  externalOutcome(actionId: string, result: JsonValue) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM actions WHERE id=? AND kind='http_fixture'").get(actionId); if (!row || row.status === 'succeeded') return;
      const attempt = JSON.parse(String(row.data_json)) as ExternalAttempt; const run = this.get(attempt.approval.runId); const nodeId = attempt.approval.nodeId;
      if (result === null) {
        if (['running','needs_attention'].includes(run.status)) this.markExternalUncertain(run.id, nodeId);
        else this.db.prepare("UPDATE actions SET status='uncertain' WHERE id=?").run(actionId);
        return;
      }
      attempt.result = result; this.db.prepare("UPDATE actions SET status='succeeded',data_json=? WHERE id=?").run(JSON.stringify(attempt), actionId);
      const approvals = new ApprovalStore(this); const approval = approvals.get(actionId); approval.status = 'applied'; approvals.save(approval);
      // Cancellation cannot undo a remote effect. Record confirmation without resuming a terminal run.
      if (!['running','needs_attention'].includes(run.status)) return;
      const step = this.steps(run.id).find(item => item.nodeId === nodeId)!; step.status = 'succeeded'; step.output = result; step.error = null; step.finishedAt = this.timestamp(); this.saveStep(step);
      run.status = 'queued'; run.error = null; this.save(run); const next = this.graph(run.workflowVersionId).edges.find(edge => edge.source === nodeId)!.target;
      this.db.prepare('UPDATE runs SET owner=NULL,next_node=? WHERE id=?').run(next, run.id); this.event(run.id, 'action_reconciled', nodeId, { actionId }); this.event(run.id, 'step_succeeded', nodeId);
    });
  }
  approvalDecision(approval: Approval, decision: 'approve' | 'reject' | 'edit') {
    const run = this.get(approval.runId);
    this.event(run.id, decision === 'edit' ? 'approval_edited' : 'approval_decided', approval.nodeId, { approvalId: approval.id, revision: approval.revision, decision });
    if (decision === 'edit') return;
    const step = this.steps(run.id).find(item => item.nodeId === approval.nodeId)!;
    if (decision === 'reject') {
      step.status = 'failed'; step.finishedAt = this.timestamp(); step.error = { code: 'TOOL_NOT_ALLOWED', message: 'Operator rejected the proposed update.', retryable: false, nodeId: step.nodeId };
      this.saveStep(step); run.error = step.error; this.event(run.id, 'step_failed', step.nodeId, { code: step.error.code }); this.finish(run, 'failed'); return;
    }
    step.status = 'pending'; this.saveStep(step); run.status = 'queued'; this.save(run); this.event(run.id, 'run_queued');
  }
  private fence(id: string, token: string) {
    const row = this.row(id);
    const lease = this.db.prepare('SELECT token,expires_at FROM worker_lease WHERE id=1').get();
    if (!lease || lease.token !== token || Number(lease.expires_at) <= this.now() || row.owner !== token || row.status !== 'running') throw new StoreError(409, 'Run is no longer owned by this worker.');
    return row;
  }
  heartbeat(id: string, token: string): boolean {
    return this.transaction(() => { this.fence(id, token); this.db.prepare('UPDATE worker_lease SET expires_at=? WHERE token=?').run(this.now() + LEASE_MS, token); return true; });
  }
  agentWork(id: string, token: string): { nodeId: string; state: AgentExecution } | null {
    const row = this.fence(id, token);
    const item = this.db.prepare('SELECT data_json FROM agent_executions WHERE run_id=? AND node_id=?').get(id, row.next_node);
    return item ? { nodeId: row.next_node!, state: JSON.parse(String(item.data_json)) as AgentExecution } : null;
  }
  agentReadTransaction(id: string, token: string, action: () => void) { return this.transaction(() => { this.fence(id, token); action(); }); }
  checkpointAgent(id: string, nodeId: string, token: string, state: AgentExecution, type: RunEvent['type'], insideTransaction = false) {
    const action = () => { const row = this.fence(id, token); if (row.next_node !== nodeId) throw new StoreError(409, 'Step changed.'); this.db.prepare('UPDATE agent_executions SET data_json=? WHERE run_id=? AND node_id=?').run(JSON.stringify(state), id, nodeId); this.event(id, type, nodeId, { requests: state.requests, toolCalls: state.tools.length }); };
    if (insideTransaction) action(); else this.transaction(action);
  }
  completeAgent(id: string, nodeId: string, token: string, output: JsonValue, error?: ExecutionError) {
    return this.transaction(() => {
      const row = this.fence(id, token); if (row.next_node !== nodeId) throw new StoreError(409, 'Step changed.');
      const run = this.get(id); const step = this.steps(id).find(item => item.nodeId === nodeId)!;
      step.finishedAt = this.timestamp(); step.output = output; step.status = error ? 'failed' : 'succeeded'; step.error = error ? { ...error, nodeId } : null;
      this.saveStep(step); this.event(id, error ? 'step_failed' : 'step_succeeded', nodeId, error ? { code: error.code } : {});
      if (error) { run.error = step.error; this.finish(run, 'failed'); return; }
      const next = this.graph(run.workflowVersionId).edges.find(edge => edge.source === nodeId)!.target;
      this.db.prepare('UPDATE runs SET next_node=? WHERE id=?').run(next, id);
    });
  }
  release(token: string) { this.db.prepare('DELETE FROM worker_lease WHERE token = ?').run(token); }
}
