# 0002 — Durable single-worker execution

Date: 2026-10-07
Status: implemented in M1

M1 executes only the four deterministic node types. The API never runs steps. A separate worker process claims the oldest available run under a global SQLite lease with a random ownership token and a 10-second expiry. Every claim and step uses an IMMEDIATE transaction. A step's result, branch skips, scheduling pointer, and ordered metadata events commit together. There is no external side effect within a transaction.

A killed process either leaves a committed result or rolls back the entire step. After lease expiry, a replacement uses the saved pointer and upstream results. Completed steps retain their original attempt and timestamps. Stale workers cannot advance under another token. Cancellation serializes with a step transaction and cancels future work; it does not undo a committed result. This protocol is intentionally limited to synchronous deterministic nodes. Model calls and external writes need a different pause/action protocol in M3/M4; do not hold a database transaction across a network request.

Run creation requires a request UUID. Repeating the same request returns the existing run; a different payload with that UUID is a conflict. Runs reference an immutable published version. Workflow edits cannot change historical execution. Event allocation is per-run monotonic and transactional. Events contain status/node/error-code metadata, not record contents. Input/output inspection is authenticated and redacts sensitive field names and configured operator-secret values; the database retains operational record data and is not a credential vault.

Operator access uses a generated high-entropy key in a private file outside the repository. Session cookies are HttpOnly, SameSite=Strict, host-only, expire after 12 hours, and are signed with the operator secret. The database stores session hashes only. Key rotation plus API restart invalidates old signatures. Mutation requests require the exact configured loopback Origin and session-derived CSRF header. Untrusted Host headers, cross-site requests, unauthenticated reads/commands, and excessive wrong-key attempts are rejected. HTTP cookies omit Secure only for loopback HTTP; this is not shared-deployment authentication.

The interface retains M0's typography and palette. It replaces the read-only preview with a supplier-record form, latest-50 run history, and expandable persisted steps/events. It does not invent worker metrics or claim AI execution. Polling reads coherent snapshots; the API also supports replay with an event-sequence cursor for M2.
