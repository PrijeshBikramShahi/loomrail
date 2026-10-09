# Milestone status

Updated: 2026-10-08

## M0 — Complete

Separate npm/Git workspace, pinned dependencies, shared versioned contracts, graph validation, state transitions, typed errors, provider capabilities, SQLite migrations, sample graph, and reference evaluator. The portfolio application remains untouched.

## M1 — Complete

Authenticated loopback API, external private operator key, signed HttpOnly sessions, Origin/Host/CSRF checks, persisted runs/steps/events, idempotent run creation, global worker lease, cancellation, and run inspection are implemented. Worker is a separate process. Event ordering, duplicate claims, transaction rollback, draft isolation, secret redaction, and failures are tested.

A real process test kills a worker after committed steps, starts a replacement, waits for lease expiry, and verifies the completed steps were not repeated. Browser checks exercised sign-in, successful execution, the review branch, and a missing-price failure. M1 finished with 73 passing tests. See decision 0002.

## M2 — Complete

React Flow editor, four-node palette, configuration and binding controls, incremental connection validation, keyboard-friendly connection forms, saved/reopened drafts, optimistic revision checks, immutable published versions, and run progress overlays are implemented. Drafts may be incomplete; publishing requires complete graph validation. Run inspection polls persisted events using the last observed sequence and refreshes snapshots only when new events arrive.

Verified in the browser by creating a blank five-node workflow, adding mapping/output bindings, connecting both condition branches, saving, reopening, publishing, and executing it. The run returned `ready_for_drafting` and the mapped fictional record. Unit tests prove publishing a changed graph while another run is active does not change that run or its historical graph. Full checks passed with 81 tests; subsequent small UI/redaction refinements passed lint/type checks and web build. The editor is a separate lazy-loaded bundle. Final regression checks will include those refinements.

## M3 — Complete for the first real provider

Fixture, Ollama, opt-in OpenAI, and allowlisted OpenRouter adapters; immutable agents; bounded asynchronous execution, persisted model/tool checkpoints, cancellation and lease fencing; read-only record/guideline tools; schema and citation validation; usage/capability inspection; and agent configuration/test UI are implemented. Fixture agent execution was verified through the browser. Unit tests cover provider errors, quotas, timeouts, malformed responses, forbidden tools, limits, cancellation, and checkpoint recovery.

OpenRouter Nemotron 3 Super completed a real, fictional catalogue run through native JSON Schema output, record lookup, guideline retrieval, provenance validation, and the durable approval boundary. The draft retained the missing price as null, flagged it, cited the retrieved source, invented no specifications, and made no record change. This satisfies the real-provider smoke gate for one provider/model and one representative case; it is not a broad model-quality claim. Ollama/OpenAI remain unverified. See decision 0004 and the [Nemotron validation record](validation/NEMOTRON.md).

## M4 — Complete for the planned local scope

Exact proposal revisions, approve/reject/edit, durable pauses, optimistic record revision checks, transactional action identities, JSON artifacts, approval queue and evidence inspection are implemented. Tests cover restart/repeated decisions/stale edits/rejection/cancellation/concurrent edits/storage rollback and existing-data migration. An actual controlled loopback HTTP service applies a write then drops its response; the run becomes uncertain and reconciliation confirms the action without repeating POST. General production connectors remain deferred.

## M5 — Complete with fixture end-to-end validation

CSV validation/import, record list/detail, immutable text/Markdown source revisions, hashes/chunks, lexical retrieval and source inspection, and an end-to-end catalogue starter are implemented. Browser acceptance imported fictional records and guidelines, started a missing-price run, preserved its pending review through shutdown/restart, edited the proposal, separately approved it, and inspected the applied artifact. Tests verify old runs retain pinned evidence after source changes. Real-model quality remains a separate gate.

## M6 — Complete for deterministic evaluation

Saved cases, candidate/current comparison, isolated fixture substitution, exact version identification, and 24 representative/adversarial catalogue cases are implemented. Intentional prompt-text and mapping regressions are detected. The browser saved a passing 24-case report. Semantic quality is not measured by those fixtures and requires inspection of real outputs.

## M7 — Packaging implemented; release acceptance remains

Native production launcher, installation/provider instructions, private backup/restore CLI, recovery guidance, limitations, architecture decisions, and a sanitized interactive replay with six recorded fixture scenarios are implemented. A fresh copied checkout passed offline install/build/replay generation. A packaged loopback server served the UI and replay, required authentication for runs, and completed a deterministic run. Backup/restore is tested through the real CLI against a WAL database.

Final browser QA passed after the OpenRouter update: both free-model modes rendered with the correct explanation and model ID, keyboard focus advanced through the form controls, a narrow viewport had no horizontal overflow, and the browser console had no warnings or errors. Remaining release work is external: an independent developer onboarding trial and a recorded video/portfolio publication if selected. The interactive trace and browser screenshots are available; no published portfolio or independent trial is claimed.

## OpenRouter free-model addition

OpenRouter supports two exact free endpoints. `nvidia/nemotron-3-super-120b-a12b:free` uses native JSON Schema and is the UI default; `poolside/laguna-s-2.1:free` uses explicitly selected prompted JSON because it does not advertise schema enforcement. The adapter requires zero token prices and disables provider fallback. Both paths parse and validate output locally before provenance and approval checks. Credential redaction and evaluation isolation include OpenRouter.

Laguna passed real prompted JSON and tool invocation, but repeated HTTP 429 responses prevented its full catalogue completion. Nemotron initially tried to draft before retrieval; Loomrail rejected its invented citation. Requiring each configured read-only tool before the schema-constrained final response corrected that behavior. The next live run reached `awaiting_approval` with all acceptance checks passing and OpenRouter reporting zero cost. No record was changed. See [Laguna notes](validation/LAGUNA.md), [Nemotron validation](validation/NEMOTRON.md), and [provider setup](PROVIDERS.md).

## Development state

- Local runtimes verified: Node 26.4.0 and Node 24.21.0. After the final OpenRouter changes, full Node 24 lint, typecheck, 131 tests across 19 files, and the production build passed. CI targets Node 24; remote CI has not been run. Local HTTP tests require loopback permission outside the sandbox.
- The implementation is prepared as a local release commit. No Git remote, pull request, hosted service, or portfolio deployment is configured.
- The visible browser uses isolated test storage at `/private/tmp/loomrail-m1-browser/data` and a disposable test key at `/private/tmp/loomrail-m1-browser/operator.key`. Do not treat this key as durable operator setup. Preserve test data while the user is inspecting it. Normal setup uses `npm run operator:init` and the repository's ignored `data/` directory.
- Web dev server is on 127.0.0.1:5173; test API on 127.0.0.1:3001 with file watching; separate test worker uses the same temporary database. Restart the worker after execution code changes.
- The user resumed implementation after a pause. The original M1–M7 objective is complete except for the external onboarding and publication activities stated above.
