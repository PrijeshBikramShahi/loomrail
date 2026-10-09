# Runtime contracts

Shared Zod schemas live in `packages/contracts`. Executable graphs, requests, and definitions use schema version 1. Unknown fields and versions are rejected. SQLite migrations are numbered and checksummed; previously applied definitions are not edited.

## Graphs

One manual trigger starts a directed tree ending in one or more outputs. Each non-trigger has exactly one parent. Conditions have one true and one false edge; ordinary steps have one next edge; outputs have none. Cycles, joins, parallel fan-out, unreachable nodes, missing references, duplicate IDs, and references outside an upstream ancestor are rejected. Limits: 100 nodes / 200 edges.

| Type | Configuration | Behavior |
| --- | --- | --- |
| manual_trigger | Empty | Copies run input |
| mapping | Named field bindings | Constructs a new JSON object |
| condition | Operator and operand bindings | Selects true/false and skips unused descendants |
| agent | Immutable agentVersionId and input binding | Bounded asynchronous generation/tool loop |
| record_update | Proposal binding; optional controlled fixture destination | Pauses for exact review, then applies an authorized action |
| output | Named field bindings | Completes the run with a JSON result |

Bindings select literal JSON, run input, or an ancestor step result. Paths contain own-property names; empty selects the whole value. Prototype keys are forbidden. Missing values fail with MISSING_VALUE, except exists treats missing/null as false. Equality is structural. Numeric greater_than never coerces strings.

Incomplete drafts may be saved with separate node positions. Saves and publication use optimistic draft revision checks. Publishing validates the complete graph and agent references, then creates an immutable workflow version. Existing runs keep that version.

## Execution and persistence

Run creation is idempotent for a request UUID plus identical version/input. A single global expiring lease and run ownership token fence workers. Scheduling, deterministic output, ordered events, and branch skips are committed transactionally. Agent requests run outside SQLite transactions; each request, response, and completed read-tool batch is checkpointed. A resumed request consumes its original iteration and elapsed-time budget.

Run states are queued, running, awaiting_approval, needs_attention, succeeded, failed, and cancelled. Steps also have pending, skipped, and uncertain states. Completed steps remain complete on restart. Cancellation ends pending/in-flight work and requests abort; it cannot reverse an external effect.

Events contain metadata and monotonic run-local sequence numbers. API detail snapshots are coherent read transactions. Event polling uses the last seen sequence. Operational context is persisted for recovery; browser projections redact configured secrets and sensitive field names. Provider credentials are environment-only and are not copied into configuration or traces.

## Agents and knowledge

Agent versions pin instructions, provider/model/settings, output JSON Schema, allowed read tools, knowledge version IDs, and input/output/tool/iteration/duration limits. Available model revision/fingerprint and reported token usage are retained in normalized responses. Unknown usage or cost is null. No silent provider fallback occurs.

Allowed tools are exact record lookup and lexical retrieval over pinned source revisions. The server validates names and arguments independently of model output. Tool responses are untrusted data. Source IDs in structured model output must come from retrieved chunks. Immutable source versions retain text, hash, chunk ordinal, and exact 1000-character windows. Citation provenance does not prove semantic correctness.

## Approvals and actions

A proposal has sku, expectedRevision, and nonempty safe changes. SKU cannot be edited through changes. The original record, exact payload, destination, revision, timestamps, and authenticated single-operator decision are retained. Editing creates a new pending revision. Stale decisions fail; repeated approval of the same version is idempotent.

Internal record update, action identity, artifact, and step completion share one transaction. Savepoints prevent partial effects when validation fails; storage errors roll back the whole transaction. A concurrent record revision causes failure rather than lost updates.

The controlled HTTP fixture has one explicitly configured numeric loopback endpoint, disallows redirects and arbitrary destinations, and requires opt-in. An in-flight action is persisted before dispatch. Unknown outcome becomes uncertain and needs attention. Reconciliation is a read by action identity and payload hash; it does not retry the write. No generic production connector is claimed.

## Evaluations and recordings

Saved cases contain immutable snapshot inputs, isolated fixture records, fixture model choice, approval policy, and assertions. Reports name exact candidate/current workflow versions and retain original agent definitions alongside explicit substitutions. Each case runs in its own in-memory database with an explicit fixture-only provider map. HTTP destinations become isolated internal records; live credentials and records are never passed to the runner.

Assertions cover status/errors, result properties, skipped branches, source provenance, forbidden actions, and required instruction text. Prompt text assertions are structural checks, not semantic model judges. Public replay data is generated separately from fictional inputs and does not read operational storage.
