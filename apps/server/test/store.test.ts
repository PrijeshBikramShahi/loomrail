import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleCatalogueInput } from '@loomrail/contracts';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations } from '../src/db/migrations.js';
import { LEASE_MS, RunStore } from '../src/store.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'loomrail-runs-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  let clock = Date.now();
  const db = openDatabase(join(directory, 'test.sqlite')); cleanups.push(() => db.close());
  applyMigrations(db);
  const store = new RunStore(db, () => clock); store.seedSample();
  return { store, path: join(directory, 'test.sqlite'), expire: () => { clock += LEASE_MS + 1; }, clock: () => clock };
}
function create(store: RunStore, input: unknown = sampleCatalogueInput, requestId = randomUUID()) {
  return store.create({ workflowVersionId: 'catalogue-v1', input, requestId });
}
function complete(store: RunStore, token = 'worker-a') {
  const id = store.claim(token)!;
  for (let i = 0; i < 100; i++) if (!store.advance(id, token)) return;
  throw new Error('Run did not terminate');
}

describe('durable deterministic execution', () => {
  it.each([24, 0, -1])('persists the correct branch for price %s', price => {
    const { store } = setup(); const run = create(store, { ...sampleCatalogueInput, price }); complete(store);
    expect(store.get(run.id).status).toBe('succeeded');
    expect(store.get(run.id).result).toMatchObject({ status: price > 0 ? 'ready_for_drafting' : 'needs_price_review' });
    expect(store.steps(run.id).find(step => step.nodeId === (price > 0 ? 'review' : 'ready'))?.status).toBe('skipped');
    expect(store.steps(run.id).every(step => step.attempt === 1)).toBe(true);
    const events = store.events(run.id);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(store.events(run.id, 3)).toEqual(events.slice(3));
  });
  it('rejects a duplicate worker claim using separate database connections', () => {
    const { store, path, clock } = setup(); const run = create(store);
    const otherDb = openDatabase(path); cleanups.push(() => otherDb.close()); const other = new RunStore(otherDb, clock);
    expect(store.claim('first')).toBe(run.id); expect(other.claim('second')).toBeNull();
    expect(() => other.advance(run.id, 'second')).toThrow('lease lost');
  });
  it('resumes from committed results after lease expiry and reopening, fencing the old owner', () => {
    const { store, path, clock, expire } = setup(); const run = create(store);
    store.claim('crashed'); store.advance(run.id, 'crashed'); store.advance(run.id, 'crashed');
    const previous = store.steps(run.id).filter(step => step.status === 'succeeded');
    expire();
    const reopenedDb = openDatabase(path); cleanups.push(() => reopenedDb.close()); const recovered = new RunStore(reopenedDb, clock);
    expect(recovered.claim('replacement')).toBe(run.id);
    expect(() => store.advance(run.id, 'crashed')).toThrow('lease lost');
    complete(recovered, 'replacement');
    expect(recovered.get(run.id).status).toBe('succeeded');
    expect(recovered.steps(run.id).filter(step => previous.some(old => old.nodeId === step.nodeId))).toEqual(previous);
    expect(recovered.events(run.id).filter(event => event.type === 'step_started' && event.nodeId === 'prepare')).toHaveLength(1);
    expect(recovered.events(run.id).some(event => event.type === 'run_resumed')).toBe(true);
  });
  it('rolls back partial step changes on a database failure', () => {
    const { store } = setup(); const run = create(store); store.claim('worker');
    store.db.exec("CREATE TRIGGER simulate_failure BEFORE UPDATE ON runs WHEN NEW.next_node = 'prepare' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
    expect(() => store.advance(run.id, 'worker')).toThrow('simulated crash');
    expect(store.steps(run.id).every(step => step.status === 'pending')).toBe(true);
    expect(store.events(run.id).some(event => event.type === 'step_started')).toBe(false);
    store.db.exec('DROP TRIGGER simulate_failure'); complete(store, 'worker');
    expect(store.get(run.id).status).toBe('succeeded');
  });
  it('cancels queued work without a worker and running work between steps', () => {
    const { store } = setup(); const queued = create(store); store.cancel(queued.id);
    expect(store.claim('worker')).toBeNull();
    expect(store.get(queued.id).status).toBe('cancelled');
    const run = create(store); store.claim('worker'); store.advance(run.id, 'worker');
    store.cancel(run.id); store.cancel(run.id);
    expect(store.advance(run.id, 'worker')).toBe(false);
    expect(store.steps(run.id)[0]?.status).toBe('succeeded');
    expect(store.steps(run.id).slice(1).every(step => step.status === 'cancelled')).toBe(true);
    expect(store.events(run.id).filter(event => event.type === 'run_cancelled')).toHaveLength(1);
  });
  it('retains typed node-level errors and completes no later steps', () => {
    const { store } = setup(); const run = create(store, { sku: 'MISSING' }); complete(store);
    expect(store.get(run.id)).toMatchObject({ status: 'failed', error: { code: 'MISSING_VALUE', nodeId: 'prepare' } });
    expect(store.steps(run.id).find(step => step.nodeId === 'check_price')?.status).toBe('skipped');
  });
  it('deduplicates retried creation and rejects changed payloads', () => {
    const { store } = setup(); const key = randomUUID(); const first = create(store, sampleCatalogueInput, key);
    expect(create(store, sampleCatalogueInput, key).id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    expect(() => create(store, { ...sampleCatalogueInput, price: 0 }, key)).toThrow('different input');
  });
  it('pins the published graph independently of subsequent draft changes', () => {
    const { store } = setup(); const run = create(store);
    store.db.prepare("UPDATE workflows SET draft_json = '{}' WHERE id = 'catalogue'").run(); complete(store);
    expect(store.get(run.id).status).toBe('succeeded');
  });
  it('does not reexecute completed runs or allocate duplicate terminal events', () => {
    const { store } = setup(); const run = create(store); complete(store);
    expect(store.claim('worker-a')).toBeNull();
    const events = store.events(run.id); expect(store.advance(run.id, 'worker-a')).toBe(false); store.cancel(run.id);
    expect(store.events(run.id)).toEqual(events);
  });
  it('validates missing versions and malformed input before creating a run', () => {
    const { store } = setup();
    expect(() => store.create({ workflowVersionId: 'missing', input: {}, requestId: randomUUID() })).toThrow('not found');
    expect(() => create(store, 'not an object')).toThrow(); expect(store.list()).toEqual([]);
  });
});
