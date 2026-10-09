# 0005 — Exact review revisions and atomic local effects

A record_update node resolves a proposal containing the SKU, expected record revision, and replacement fields. The worker pauses before writing. Decisions reference the proposal revision. Editing preserves record identity and requires another decision; stale approval requests fail. Approval is attributed to the authenticated single operator. Rejection and cancellation retain the decision history.

On resume, a unique action ID (the approval ID), record update, JSON artifact, and step outcome are committed in one SQLite transaction. A savepoint rolls back side effects before recording a typed step failure. Storage failures roll back the entire transaction. Record revision checks prevent overwriting changes made after review. This provides duplicate prevention for internal writes, not universal exactly-once external execution.

Migration 5 rebuilds the runs table to permit durable pause states. Foreign-key enforcement is disabled only on the migration connection before BEGIN IMMEDIATE, all references are checked before COMMIT, and enforcement is restored in finally. Existing-run migration tests include child rows; an empty-database test alone would not catch the table-rebuild issue.

Text documents and generated JSON artifacts currently live in SQLite, so an atomic database backup includes them. Imported files are decoded as bounded text; filenames never become server filesystem paths. Knowledge versions and chunks are immutable; published agents pin specific version IDs. Retrieval is deterministic lexical matching, not vector or hybrid search. CSV imports create new SKUs and never silently overwrite existing records.
