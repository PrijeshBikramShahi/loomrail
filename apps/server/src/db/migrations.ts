import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface Migration { version: number; name: string; sql: string }
export const migrations: readonly Migration[] = [{
  version: 1,
  name: 'workflow_contracts',
  sql: `
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
      layout_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(layout_json)),
      published_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (id, published_version_id) REFERENCES workflow_versions(workflow_id, id)
    ) STRICT;
    CREATE TABLE workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      version INTEGER NOT NULL CHECK (version > 0),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
      created_at TEXT NOT NULL,
      UNIQUE (workflow_id, version),
      UNIQUE (workflow_id, id)
    ) STRICT;
    CREATE TRIGGER workflow_version_no_update BEFORE UPDATE ON workflow_versions
    BEGIN SELECT RAISE(ABORT, 'Published workflow versions are immutable'); END;
    CREATE TRIGGER workflow_version_no_delete BEFORE DELETE ON workflow_versions
    BEGIN SELECT RAISE(ABORT, 'Published workflow versions are immutable'); END;
  `,
}, {
  version: 2,
  name: 'durable_runs_and_sessions',
  sql: `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
      request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
      next_node TEXT,
      owner TEXT,
      data_json TEXT NOT NULL CHECK (json_valid(data_json))
    ) STRICT;
    CREATE INDEX runs_status ON runs(status);
    CREATE TABLE step_runs (
      run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL,
      data_json TEXT NOT NULL CHECK (json_valid(data_json)), PRIMARY KEY (run_id, node_id)
    ) STRICT;
    CREATE TABLE run_events (
      run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL CHECK (sequence > 0),
      data_json TEXT NOT NULL CHECK (json_valid(data_json)), PRIMARY KEY (run_id, sequence)
    ) STRICT;
    CREATE TABLE worker_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
    CREATE TRIGGER workflow_version_no_replace BEFORE INSERT ON workflow_versions
      WHEN EXISTS (SELECT 1 FROM workflow_versions WHERE id = NEW.id OR (workflow_id = NEW.workflow_id AND version = NEW.version))
    BEGIN SELECT RAISE(ABORT, 'Published workflow versions are immutable'); END;
  `,
}, {
  version: 3,
  name: 'draft_revisions',
  sql: 'ALTER TABLE workflows ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0 CHECK (draft_revision >= 0);',
}, {
  version: 4,
  name: 'agents_and_grounded_data',
  sql: `
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
    CREATE TABLE agent_versions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), version INTEGER NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)), UNIQUE(agent_id,version)) STRICT;
    CREATE TRIGGER agent_version_no_update BEFORE UPDATE ON agent_versions BEGIN SELECT RAISE(ABORT, 'Agent versions are immutable'); END;
    CREATE TRIGGER agent_version_no_delete BEFORE DELETE ON agent_versions BEGIN SELECT RAISE(ABORT, 'Agent versions are immutable'); END;
    CREATE TRIGGER agent_version_no_replace BEFORE INSERT ON agent_versions WHEN EXISTS(SELECT 1 FROM agent_versions WHERE id=NEW.id OR (agent_id=NEW.agent_id AND version=NEW.version)) BEGIN SELECT RAISE(ABORT, 'Agent versions are immutable'); END;
    CREATE TABLE agent_executions (run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)), PRIMARY KEY(run_id,node_id)) STRICT;
    CREATE TABLE records (sku TEXT PRIMARY KEY, revision INTEGER NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT;
    CREATE TABLE knowledge_versions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, content_hash TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source_id,version)) STRICT;
    CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES knowledge_versions(id), ordinal INTEGER NOT NULL, text TEXT NOT NULL, UNIQUE(version_id,ordinal)) STRICT;
    CREATE TRIGGER knowledge_no_update BEFORE UPDATE ON knowledge_versions BEGIN SELECT RAISE(ABORT, 'Sources are immutable'); END;
    CREATE TRIGGER knowledge_no_delete BEFORE DELETE ON knowledge_versions BEGIN SELECT RAISE(ABORT, 'Sources are immutable'); END;
    CREATE TRIGGER knowledge_no_replace BEFORE INSERT ON knowledge_versions WHEN EXISTS(SELECT 1 FROM knowledge_versions WHERE id=NEW.id OR (source_id=NEW.source_id AND version=NEW.version)) BEGIN SELECT RAISE(ABORT, 'Sources are immutable'); END;
    CREATE TRIGGER chunk_no_update BEFORE UPDATE ON knowledge_chunks BEGIN SELECT RAISE(ABORT, 'Chunks are immutable'); END;
    CREATE TRIGGER chunk_no_delete BEFORE DELETE ON knowledge_chunks BEGIN SELECT RAISE(ABORT, 'Chunks are immutable'); END;
    CREATE TRIGGER chunk_no_replace BEFORE INSERT ON knowledge_chunks WHEN EXISTS(SELECT 1 FROM knowledge_chunks WHERE id=NEW.id OR (version_id=NEW.version_id AND ordinal=NEW.ordinal)) BEGIN SELECT RAISE(ABORT, 'Chunks are immutable'); END;
  `,
}, {
  version: 5,
  name: 'durable_approvals_and_actions',
  sql: `
    CREATE TABLE runs_next (
      id TEXT PRIMARY KEY, workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id), request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_approval','succeeded','failed','cancelled','needs_attention')),
      next_node TEXT, owner TEXT, data_json TEXT NOT NULL CHECK(json_valid(data_json))
    ) STRICT;
    INSERT INTO runs_next SELECT * FROM runs;
    DROP TABLE runs;
    ALTER TABLE runs_next RENAME TO runs;
    CREATE INDEX runs_status ON runs(status);
    CREATE TABLE approvals (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),node_id TEXT NOT NULL,status TEXT NOT NULL,data_json TEXT NOT NULL CHECK(json_valid(data_json)),UNIQUE(run_id,node_id)) STRICT;
    CREATE TABLE approval_history (approval_id TEXT NOT NULL REFERENCES approvals(id),sequence INTEGER NOT NULL,data_json TEXT NOT NULL CHECK(json_valid(data_json)),PRIMARY KEY(approval_id,sequence)) STRICT;
    CREATE TABLE actions (id TEXT PRIMARY KEY,run_id TEXT REFERENCES runs(id),kind TEXT NOT NULL,status TEXT NOT NULL,data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT;
    CREATE TABLE artifacts (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),name TEXT NOT NULL,data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT;
  `,
}, {
  version: 6,
  name: 'saved_evaluations',
  sql: `
    CREATE TABLE test_cases (id TEXT PRIMARY KEY,data_json TEXT NOT NULL CHECK(json_valid(data_json)),created_at TEXT NOT NULL) STRICT;
    CREATE TABLE evaluations (id TEXT PRIMARY KEY,candidate_version_id TEXT NOT NULL REFERENCES workflow_versions(id),current_version_id TEXT REFERENCES workflow_versions(id),data_json TEXT NOT NULL CHECK(json_valid(data_json)),created_at TEXT NOT NULL) STRICT;
  `,
}];

function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

export function applyMigrations(db: DatabaseSync, definitions: readonly Migration[] = migrations): number[] {
  const ordered = [...definitions].sort((a, b) => a.version - b.version);
  if (ordered.some((item, index) => !Number.isSafeInteger(item.version) || item.version !== index + 1)) {
    throw new Error('Migration versions must be consecutive positive integers starting at 1.');
  }
  // Rebuilding a referenced table requires foreign keys off outside the transaction.
  // Validate the complete database before commit and always restore enforcement.
  db.exec('PRAGMA foreign_keys=OFF');
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true;
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT`);
    const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    for (const [index, row] of applied.entries()) {
      const definition = ordered.find(item => item.version === row.version);
      if (row.version !== index + 1 || !definition || definition.name !== row.name || checksum(definition) !== row.checksum) {
        throw new Error(`Migration history mismatch at version ${String(row.version)}. Restore matching application code before migrating.`);
      }
    }
    const installed: number[] = [];
    for (const migration of ordered.slice(applied.length)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, checksum(migration), new Date().toISOString());
      installed.push(migration.version);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration would violate foreign key integrity.');
    db.exec('COMMIT');
    return installed;
  } catch (error) {
    if (begun) db.exec('ROLLBACK');
    throw error;
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
}
