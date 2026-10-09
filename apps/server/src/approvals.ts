import { approvalSchema, decisionSchema, proposedUpdateSchema, type Approval, type JsonValue } from '@loomrail/contracts';
import { randomUUID } from 'node:crypto';
import { StoreError, type RunStore } from './store.js';

export class ApprovalStore {
  constructor(readonly store: RunStore) {}
  list(): Approval[] { return this.store.db.prepare('SELECT data_json FROM approvals ORDER BY rowid DESC LIMIT 100').all().map(row => approvalSchema.parse(JSON.parse(String(row.data_json)))); }
  get(id: string): Approval {
    const row = this.store.db.prepare('SELECT data_json FROM approvals WHERE id=?').get(id);
    if (!row) throw new StoreError(404, 'Approval not found.');
    return approvalSchema.parse(JSON.parse(String(row.data_json)));
  }
  forStep(runId: string, nodeId: string): Approval | null {
    const row = this.store.db.prepare('SELECT data_json FROM approvals WHERE run_id=? AND node_id=?').get(runId, nodeId);
    return row ? approvalSchema.parse(JSON.parse(String(row.data_json))) : null;
  }
  // Caller holds the execution transaction.
  propose(runId: string, nodeId: string, value: JsonValue, destination = 'records'): Approval {
    const payload = proposedUpdateSchema.parse(value);
    const record = this.store.db.prepare('SELECT * FROM records WHERE sku=?').get(payload.sku);
    if (!record) throw new StoreError(400, 'Proposed record does not exist.');
    if (Number(record.revision) !== payload.expectedRevision) throw new StoreError(409, 'Record revision changed; prepare a new proposal.');
    const approval = approvalSchema.parse({ id: randomUUID(), runId, nodeId, destination, revision: 1, status: 'pending', payload, original: JSON.parse(String(record.data_json)), createdAt: new Date(this.store.now()).toISOString(), decidedAt: null, operator: null });
    this.store.db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?)').run(approval.id, runId, nodeId, approval.status, JSON.stringify(approval));
    this.history(approval); return approval;
  }
  private history(approval: Approval) {
    const sequence = Number(this.store.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM approval_history WHERE approval_id=?').get(approval.id)!.next);
    this.store.db.prepare('INSERT INTO approval_history VALUES (?,?,?)').run(approval.id, sequence, JSON.stringify(approval));
  }
  save(approval: Approval) { this.store.db.prepare('UPDATE approvals SET status=?,data_json=? WHERE id=?').run(approval.status, JSON.stringify(approval), approval.id); this.history(approval); }
  decide(id: string, value: unknown) {
    const decision = decisionSchema.parse(value);
    return this.store.transaction(() => {
      const approval = this.get(id);
      if (approval.revision !== decision.revision) throw new StoreError(409, 'This proposal changed. Review the current payload before deciding.');
      if (decision.decision === 'approve' && ['approved', 'applied'].includes(approval.status)) return approval;
      if (decision.decision === 'reject' && approval.status === 'rejected') return approval;
      if (approval.status !== 'pending') throw new StoreError(409, 'This proposal can no longer be changed.');
      if (this.store.get(approval.runId).status !== 'awaiting_approval') throw new StoreError(409, 'Run is no longer awaiting this decision.');
      if (decision.decision === 'edit') {
        if (decision.payload.sku !== approval.payload.sku || decision.payload.expectedRevision !== approval.payload.expectedRevision) throw new StoreError(400, 'Edits cannot change the record identity or expected revision. Start a new run for a different record.');
        approval.payload = decision.payload; approval.revision++; approval.decidedAt = null; approval.operator = null;
      } else { approval.status = decision.decision === 'approve' ? 'approved' : 'rejected'; approval.decidedAt = new Date(this.store.now()).toISOString(); approval.operator = 'operator'; }
      this.save(approval); this.store.approvalDecision(approval, decision.decision);
      return approval;
    });
  }
  // Action, record update, artifact, and step completion share the worker transaction.
  apply(approval: Approval): JsonValue {
    const previous = this.store.db.prepare('SELECT data_json FROM actions WHERE id=?').get(approval.id);
    if (previous) return JSON.parse(String(previous.data_json)) as JsonValue;
    if (approval.status !== 'approved') throw new StoreError(409, 'Exact proposal has not been approved.');
    const row = this.store.db.prepare('SELECT revision,data_json FROM records WHERE sku=?').get(approval.payload.sku);
    if (!row || Number(row.revision) !== approval.payload.expectedRevision) throw new StoreError(409, 'Record changed after review. Start a new run and review the new revision.');
    const record = { ...JSON.parse(String(row.data_json)) as Record<string, JsonValue>, ...approval.payload.changes };
    const revision = Number(row.revision) + 1;
    this.store.db.prepare('UPDATE records SET revision=?,data_json=? WHERE sku=? AND revision=?').run(revision, JSON.stringify(record), approval.payload.sku, approval.payload.expectedRevision);
    const output = { actionId: approval.id, sku: approval.payload.sku, revision, record, artifactId: approval.id };
    this.store.db.prepare('INSERT INTO actions VALUES (?,?,?,?,?)').run(approval.id, approval.runId, 'record_update', 'succeeded', JSON.stringify(output));
    this.store.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)').run(approval.id, approval.runId, `listing-${approval.id}.json`, JSON.stringify(record));
    approval.status = 'applied'; this.save(approval); return output;
  }
}
