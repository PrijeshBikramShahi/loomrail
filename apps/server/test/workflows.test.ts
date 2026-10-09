import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleCatalogueGraph, sampleCatalogueInput, type WorkflowDocument } from '@loomrail/contracts';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations } from '../src/db/migrations.js';
import { RunStore } from '../src/store.js';

const stores: RunStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });
function setup() { const db = openDatabase(':memory:'); applyMigrations(db); const store = new RunStore(db); store.seedSample(); stores.push(store); return store; }
function body(draft: WorkflowDocument) { return { schemaVersion: draft.schemaVersion, name: draft.name, graph: draft.graph, layout: draft.layout, revision: draft.revision }; }

describe('drafts and immutable publication', () => {
  it('creates and reopens incomplete drafts but refuses to publish them', () => {
    const store = setup(); const draft = store.createWorkflow({ name: 'New workflow' });
    expect(draft.graph.nodes).toEqual([]); expect(draft.publishedVersionId).toBeNull();
    expect(store.workflow(draft.id)).toEqual(draft);
    expect(() => store.publish(draft.id, { revision: draft.revision })).toThrow();
  });
  it('saves a graph and layout, publishes it, and creates a run from the published version', () => {
    const store = setup(); const draft = store.createWorkflow({ name: 'Visual catalogue' });
    const saved = store.saveDraft(draft.id, { ...body(draft), graph: sampleCatalogueGraph, layout: { start: { x: 10, y: 20 } } });
    expect(store.workflow(draft.id).layout.start).toEqual({ x: 10, y: 20 });
    const published = store.publish(draft.id, { revision: saved.revision });
    expect(published.version.version).toBe(1); expect(published.workflow.revision).toBe(2);
    const run = store.create({ requestId: randomUUID(), workflowVersionId: published.version.id, input: sampleCatalogueInput });
    store.claim('worker'); while (store.advance(run.id, 'worker')) { /* execute deterministic graph */ }
    expect(store.get(run.id).status).toBe('succeeded');
  });
  it('rejects stale saves and stale publication without losing newer edits', () => {
    const store = setup(); const original = store.workflow('catalogue');
    const saved = store.saveDraft('catalogue', { ...body(original), name: 'New name' });
    expect(() => store.saveDraft('catalogue', body(original))).toThrow('another tab');
    expect(() => store.publish('catalogue', { revision: original.revision })).toThrow('changed');
    expect(store.workflow('catalogue')).toEqual(saved);
  });
  it('never changes an in-progress run or historical version when drafts are published', () => {
    const store = setup(); const run = store.create({ requestId: randomUUID(), workflowVersionId: 'catalogue-v1', input: sampleCatalogueInput });
    store.claim('worker'); store.advance(run.id, 'worker');
    const draft = store.workflow('catalogue'); const graph = structuredClone(draft.graph);
    const mapping = graph.nodes.find(node => node.type === 'mapping')!;
    mapping.config.fields.price = { source: 'literal', value: 0 };
    const saved = store.saveDraft('catalogue', { ...body(draft), graph });
    const publication = store.publish('catalogue', { revision: saved.revision });
    expect(publication.version.version).toBe(2);
    while (store.advance(run.id, 'worker')) { /* old graph */ }
    expect(store.get(run.id).result).toMatchObject({ status: 'ready_for_drafting' });
    expect(store.detail(run.id).graph).toEqual(sampleCatalogueGraph);
    const next = store.create({ requestId: randomUUID(), workflowVersionId: publication.version.id, input: sampleCatalogueInput });
    store.claim('worker'); while (store.advance(next.id, 'worker')) { /* new graph */ }
    expect(store.get(next.id).result).toMatchObject({ status: 'needs_price_review' });
  });
  it('validates branch joins at publish even if a draft was saved through the API', () => {
    const store = setup(); const draft = store.workflow('catalogue'); const graph = structuredClone(draft.graph);
    graph.edges[3]!.target = 'ready';
    const saved = store.saveDraft('catalogue', { ...body(draft), graph });
    expect(() => store.publish('catalogue', { revision: saved.revision })).toThrow('fan-in');
    expect(store.workflow('catalogue').publishedVersionId).toBe('catalogue-v1');
  });
});
