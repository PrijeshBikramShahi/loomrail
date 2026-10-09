import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations, migrations } from '../src/db/migrations.js';

const connections: DatabaseSync[] = [];
const directories: string[] = [];
function database() { const db = openDatabase(':memory:'); connections.push(db); return db; }
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function addWorkflow(db: DatabaseSync, id = 'catalogue') {
  db.prepare("INSERT INTO workflows (id, name, schema_version, draft_json, created_at, updated_at) VALUES (?, 'Catalogue', 1, '{}', '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z')").run(id);
}

describe('SQLite migrations', () => {
  it('applies once and enables foreign keys', () => {
    const db = database();
    expect(applyMigrations(db)).toEqual(migrations.map(item => item.version));
    expect(applyMigrations(db)).toEqual([]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
  });
  it('survives closing and reopening a file-backed database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'loomrail-test-')); directories.push(directory);
    const path = join(directory, 'test.sqlite');
    const first = openDatabase(path);
    try { applyMigrations(first); addWorkflow(first); } finally { first.close(); }
    const second = openDatabase(path); connections.push(second);
    expect(applyMigrations(second)).toEqual([]);
    expect(second.prepare('SELECT id FROM workflows').get()).toMatchObject({ id: 'catalogue' });
  });
  it('rolls back both DDL and migration bookkeeping on error', () => {
    const db = database(); applyMigrations(db);
    expect(() => applyMigrations(db, [...migrations, { version: migrations.length + 1, name: 'broken', sql: 'CREATE TABLE transient (id TEXT); INSERT INTO missing_table VALUES (1);' }])).toThrow('missing_table');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'transient'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toMatchObject({ count: migrations.length });
  });
  it('detects edited or unknown applied migrations', () => {
    const db = database(); applyMigrations(db);
    expect(() => applyMigrations(db, [{ ...migrations[0]!, sql: 'SELECT 1;' }])).toThrow('history mismatch');
    expect(() => applyMigrations(db, [])).toThrow('history mismatch');
  });
  it('rejects gaps and duplicate migration versions', () => {
    const db = database();
    expect(() => applyMigrations(db, [{ version: 2, name: 'gap', sql: 'SELECT 1;' }])).toThrow('consecutive');
    expect(() => applyMigrations(db, [migrations[0]!, migrations[0]!])).toThrow('consecutive');
  });
  it('enforces immutable published versions and parent references', () => {
    const db = database(); applyMigrations(db);
    const insert = db.prepare("INSERT INTO workflow_versions VALUES (?, ?, 1, 1, '{}', '2026-10-07T00:00:00Z')");
    expect(() => insert.run('v1', 'missing')).toThrow('FOREIGN KEY');
    addWorkflow(db); insert.run('v1', 'catalogue');
    expect(() => db.prepare("UPDATE workflow_versions SET graph_json = '[]' WHERE id = 'v1'").run()).toThrow('immutable');
    expect(() => db.prepare("DELETE FROM workflow_versions WHERE id = 'v1'").run()).toThrow('immutable');
    expect(() => db.prepare("INSERT OR REPLACE INTO workflow_versions VALUES ('v1', 'catalogue', 1, 1, '[]', '2026-10-07T00:00:00Z')").run()).toThrow('immutable');
    addWorkflow(db, 'other');
    expect(() => db.prepare("UPDATE workflows SET published_version_id = 'v1' WHERE id = 'other'").run()).toThrow('FOREIGN KEY');
    db.prepare("UPDATE workflows SET published_version_id = 'v1' WHERE id = 'catalogue'").run();
  });
});
