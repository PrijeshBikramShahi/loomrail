# Recovery and backups

Use the same absolute data directory for API and worker. SQLite WAL supports concurrent reads and short writes; keep storage on a local disk. Do not copy just the main SQLite file while services are writing.

## Worker restart

A graceful stop releases the global lease. After a forced stop, ownership expires in about ten seconds. A replacement resumes committed scheduling state and preserves completed steps. An interrupted model request may be retried within its original time/iteration budget. Completed tool batches are retained. If the duration expires while offline, the agent fails with TIMEOUT instead of starting a fresh budget.

Review pauses survive API/worker shutdown. Approve the displayed proposal revision after restarting. Edits increment the revision, so old approval requests cannot authorize new fields. A changed record revision fails rather than overwriting concurrent changes.

An external fixture action left in-flight becomes uncertain on recovery. Inspect its action identity and use the read-only reconciliation control in Approvals. A matching confirmed result resumes the run; an unknown result remains uncertain. No blind POST retry is performed. Cancellation stops future work and does not undo a remote effect.

## Online backup

```sh
LOOMRAIL_DATA_DIR=/absolute/path/data npm run backup -- /absolute/path/backups/unique-name.sqlite
```

The command uses SQLite's online backup API, verifies database and foreign-key integrity and migration history, removes sessions/leases from the copy, and publishes a private 0600 file without replacing an existing destination. Source text and generated JSON artifacts are stored in SQLite and included. The external operator key and environment credentials are not included.

Backups may restart internally if another connection writes while pages are copied. For a heavily active workspace, stop API and worker for the backup window. Keep the resulting file private and separately protect operator/provider credentials.

## Restore rehearsal

```sh
npm run restore -- /absolute/path/backup.sqlite /absolute/path/restored-data
```

The target must be new or empty. The command never overwrites an existing workspace. Stop existing services before launching a restored copy so two installations do not perform the same pending actions. Set `LOOMRAIL_DATA_DIR` to the restored directory, use the separately retained operator key, and sign in again. Review pending and uncertain actions before permitting external fixture dispatch.

The automated CLI test snapshots an active WAL workspace after a committed step, restores into another directory, verifies session removal, and resumes without repeating that step. Restore into an occupied directory and backup overwrite are rejected. This checks local restore behavior; it does not establish offsite disaster recovery or universal exactly-once external effects.

## Key rotation

Stop the API, create a new random private key outside the repository, update its configured path, and restart. Existing signed cookies become invalid. Provider keys remain environment secrets; restart both API and worker after changing them. Never paste credentials into workflow exports or bug reports.
