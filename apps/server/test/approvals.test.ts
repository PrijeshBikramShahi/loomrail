import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { type WorkflowGraph } from '@loomrail/contracts';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations, migrations } from '../src/db/migrations.js';
import { RunStore } from '../src/store.js';
import { ApprovalStore } from '../src/approvals.js';
const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });
export const approvalGraph: WorkflowGraph = { schemaVersion: 1, nodes: [
  { id: 'start', name: 'Start', type: 'manual_trigger', config: {} }, { id: 'review', name: 'Review changes', type: 'record_update', config: { proposal: { source: 'input', path: [] } } }, { id: 'output', name: 'Output', type: 'output', config: { fields: { applied: { source: 'step', nodeId: 'review', path: [] } } } },
], edges: [{ id: 'a', source: 'start', target: 'review', port: 'next' }, { id: 'b', source: 'review', target: 'output', port: 'next' }] };
function setup() {
  const db = openDatabase(':memory:'); applyMigrations(db); const store = new RunStore(db); stores.push(store);
  const draft = store.createWorkflow({ name: 'Review' }); const saved = store.saveDraft(draft.id, { schemaVersion: 1, name: draft.name, layout: {}, revision: 0, graph: approvalGraph }); const published = store.publish(draft.id, { revision: saved.revision });
  store.db.prepare('INSERT INTO records VALUES (?,1,?)').run('DEMO', JSON.stringify({ sku: 'DEMO', title: 'Before' }));
  const run = store.create({ workflowVersionId: published.version.id, requestId: randomUUID(), input: { sku: 'DEMO', expectedRevision: 1, changes: { title: 'After' } } });
  store.claim('w'); while (store.advance(run.id, 'w')) { /* pause */ }
  return { store, approvals: new ApprovalStore(store), run };
}
describe('reviewed transactional actions', () => {
  it('pauses durably, accepts one decision, resumes and applies exactly once', () => {
    const { store, approvals, run } = setup(); expect(store.get(run.id).status).toBe('awaiting_approval'); expect(store.claim('w')).toBeNull();
    const approval = approvals.list()[0]!; expect(approval.original.title).toBe('Before');
    const replacement = new RunStore(store.db); const decisions = new ApprovalStore(replacement);
    decisions.decide(approval.id, { decision: 'approve', revision: 1 }); decisions.decide(approval.id, { decision: 'approve', revision: 1 });
    replacement.claim('w'); while (replacement.advance(run.id, 'w')) { /* resume */ }
    expect(replacement.get(run.id).status).toBe('succeeded'); expect(store.db.prepare('SELECT revision FROM records').get()!.revision).toBe(2);
    decisions.decide(approval.id, { decision: 'approve', revision: 1 }); expect(store.db.prepare('SELECT count(*) AS count FROM actions').get()!.count).toBe(1); expect(store.db.prepare('SELECT count(*) AS count FROM artifacts').get()!.count).toBe(1);
  });
  it('edits invalidate stale approvals and require a separate decision', () => {
    const { store, approvals, run } = setup(); const approval = approvals.list()[0]!;
    approvals.decide(approval.id, { decision: 'edit', revision: 1, payload: { ...approval.payload, changes: { title: 'Edited' } } });
    expect(store.get(run.id).status).toBe('awaiting_approval'); expect(() => approvals.decide(approval.id, { decision: 'approve', revision: 1 })).toThrow('changed');
    approvals.decide(approval.id, { decision: 'approve', revision: 2 }); store.claim('w'); while (store.advance(run.id, 'w')) { /* resume */ }
    expect(JSON.parse(String(store.db.prepare('SELECT data_json FROM records').get()!.data_json)).title).toBe('Edited');
  });
  it('rejects changed records without overwriting concurrent updates', () => {
    const { store, approvals, run } = setup(); const approval = approvals.list()[0]!;
    store.db.prepare('UPDATE records SET revision=2').run(); approvals.decide(approval.id, { decision: 'approve', revision: 1 }); store.claim('w'); store.advance(run.id, 'w');
    expect(store.get(run.id).status).toBe('failed'); expect(store.get(run.id).error?.message).toContain('changed'); expect(store.db.prepare('SELECT count(*) AS count FROM actions').get()!.count).toBe(0);
  });
  it.each(['reject','cancel'])('%s leaves the record unchanged and cannot later approve', decision => {
    const { store, approvals, run } = setup(); const approval = approvals.list()[0]!;
    if (decision === 'reject') approvals.decide(approval.id, { decision: 'reject', revision: 1 }); else store.cancel(run.id);
    expect(() => approvals.decide(approval.id, { decision: 'approve', revision: 1 })).toThrow(); expect(store.db.prepare('SELECT revision FROM records').get()!.revision).toBe(1);
  });
  it('rolls back record, action, artifact and state together on persistence failure', () => {
    const { store, approvals, run } = setup(); approvals.decide(approvals.list()[0]!.id, { decision: 'approve', revision: 1 });
    store.db.exec("CREATE TRIGGER fail_artifact BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT,'disk simulation'); END;");
    store.claim('w'); expect(() => store.advance(run.id, 'w')).toThrow('disk simulation');
    // Failed node must not leave an applied action or record update behind.
    expect(store.db.prepare('SELECT revision FROM records').get()!.revision).toBe(1); expect(store.db.prepare('SELECT count(*) AS count FROM actions').get()!.count).toBe(0);
  });
  it('migrates existing runs and child rows while preserving foreign keys', () => {
    const db = openDatabase(':memory:'); applyMigrations(db, migrations.slice(0,4)); const store = new RunStore(db); stores.push(store); store.seedSample();
    const run = store.create({ requestId: randomUUID(), workflowVersionId: 'catalogue-v1', input: { sku: 'old' } }); applyMigrations(db);
    expect(store.steps(run.id).length).toBeGreaterThan(0); expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]); expect(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
  });
});
