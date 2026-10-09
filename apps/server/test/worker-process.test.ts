import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { sampleCatalogueInput, workflowGraphSchema, type WorkflowGraph } from '@loomrail/contracts';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations } from '../src/db/migrations.js';
import { RunStore } from '../src/store.js';

async function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(signal); await exited;
}
async function until(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for worker state.'); await setTimeout(20); }
}

it('recovers a real killed worker process without repeating committed steps', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'loomrail-process-'));
  const db = openDatabase(join(directory, 'loomrail.sqlite')); applyMigrations(db);
  const store = new RunStore(db); store.seedSample();
  const children: ChildProcess[] = [];
  let diagnostics = '';
  const launch = () => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/worker.ts', import.meta.url))], { env: { ...process.env, LOOMRAIL_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr?.on('data', data => { diagnostics += String(data); }); children.push(child); return child;
  };
  try {
    const graph: WorkflowGraph = { schemaVersion: 1, nodes: [{ id: 'start', name: 'Start', type: 'manual_trigger', config: {} }], edges: [] };
    let previous = 'start';
    for (let i = 0; i < 20; i++) {
      const id = `map_${i}`; graph.nodes.push({ id, name: id, type: 'mapping', config: { fields: { sku: { source: 'input', path: ['sku'] } } } });
      graph.edges.push({ id: `edge_${i}`, source: previous, target: id, port: 'next' }); previous = id;
    }
    graph.nodes.push({ id: 'end', name: 'End', type: 'output', config: { fields: { result: { source: 'literal', value: 'done' } } } });
    graph.edges.push({ id: 'edge_end', source: previous, target: 'end', port: 'next' });
    db.prepare('INSERT INTO workflow_versions VALUES (?, ?, ?, ?, ?, ?)').run('recovery-v2', 'catalogue', 2, 1, JSON.stringify(workflowGraphSchema.parse(graph)), new Date().toISOString());
    const run = store.create({ workflowVersionId: 'recovery-v2', requestId: randomUUID(), input: sampleCatalogueInput });
    const first = launch();
    await until(() => store.steps(run.id).filter(step => step.status === 'succeeded').length >= 2, 5000);
    await stop(first, 'SIGKILL');
    const committed = store.steps(run.id).filter(step => step.status === 'succeeded');
    expect(committed.length).toBeLessThan(graph.nodes.length);
    launch();
    await until(() => store.get(run.id).status === 'succeeded', 16_000);
    expect(store.steps(run.id).filter(step => committed.some(old => old.nodeId === step.nodeId))).toEqual(committed);
    for (const step of committed) expect(store.events(run.id).filter(event => event.type === 'step_started' && event.nodeId === step.nodeId)).toHaveLength(1);
    expect(store.events(run.id).some(event => event.type === 'run_resumed')).toBe(true);
  } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`, { cause: error }); }
  finally { for (const child of children) await stop(child, 'SIGTERM'); db.close(); rmSync(directory, { recursive: true, force: true }); }
}, 25_000);
