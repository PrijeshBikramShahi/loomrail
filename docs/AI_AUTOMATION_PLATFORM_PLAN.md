# Loomrail — Incremental Implementation Plan

Status: planning approved; application implementation has not started.
Date: 2026-10-06

Product name: Loomrail. Repository slug: `loomrail`. Domain, trademark, and existing-product availability have not been checked.

This brief is stored alongside the portfolio for convenience. The product must be implemented in a separate repository, not inside the portfolio application. No domain purchase, hosting subscription, or external account creation is required to begin.

## 1. Product and constraints

Build a standalone platform combining visual workflow automation with agent management. Users configure deterministic steps, bounded AI agents, knowledge access, approvals, and execution inspection in one application. There is no n8n dependency.

Initial audience: developers and small technical teams.

Initial deliverable: a credible portfolio MVP that another developer can run locally and later self-host. It is not initially a public multi-tenant SaaS.

Budget: no required new spending. Avoid mandatory paid APIs, expiring credits, managed databases, subscriptions, and always-on cloud infrastructure. Existing computer, electricity, network, storage, and any existing coding-assistant access are assumed; these are not literally costless.

The application is server-backed and provider-independent. Local development does not imply a permanently local-only product. The operator supplies infrastructure and, when using remote models, their own provider credentials and any associated charges.

Success means demonstrating a complete working process, including failure and recovery, rather than matching every Sentinel or n8n feature. Claims of superiority require measured comparisons and are not established by this plan.

## 2. First-release scope

Included:

- Single operator and single workspace, with authenticated local access.
- Visual workflow editing, validation, immutable published versions, and manual execution.
- Configurable agents with instructions, output contracts, assigned tools, and execution limits.
- Provider interface with deterministic fixtures, local inference, and user-configured remote inference.
- Persisted runs, step results, tool calls, errors, cancellation, and approval decisions.
- CSV-backed business records and small text/Markdown knowledge collections.
- Saved regression cases and release comparisons with external actions disabled in tests.
- One polished end-to-end example, installation instructions, and an honest public demonstration.

Deferred:

- Multi-user SaaS, billing, organization isolation, SSO, and collaboration.
- Arbitrary code execution, shell access, computer use, and browser automation.
- Agent swarms, autonomous production edits, automatic model routing, and workflow generation.
- Arbitrary graph cycles, parallel joins, recursive subflows, and distributed workers.
- PDF/OCR pipelines, large knowledge corpora, marketplaces, and hundreds of connectors.
- Unrestricted public webhooks and a continuously available hosted AI demo.

## 3. Architecture

### Application components

| Component | Initial choice | Responsibility |
| --- | --- | --- |
| Web interface | React, TypeScript, Vite | Canvas, forms, agent configuration, run inspection, approvals |
| Graph editor | Open-source React Flow core | Node placement and connections; not execution semantics |
| API | Node.js, TypeScript, Fastify | Validation, authentication, persistence, commands, event delivery |
| Worker | Separate process from the same codebase | Claim runs, execute steps, handle durable pauses and recovery |
| Database | SQLite with migrations and foreign keys | Configuration, versions, runs, events, records, approvals |
| Files | Configurable local data directory | Imported documents and generated artifacts |
| Models | Provider adapters | Fixtures, local inference, and explicitly configured remote inference |
| Tests | Unit, API integration, and browser tests | Contracts, execution correctness, failure handling, user flows |

Use a small npm workspace in the new repository: `apps/web`, `apps/server`, `packages/contracts`, `packages/engine`, and `packages/providers`. Keep API and worker entry points in the server package. Avoid adding services merely to fill an architectural pattern.

Choose compatible stable dependency versions at scaffolding time and commit one lockfile. Do not install product dependencies into the portfolio repository.

### Execution ownership

The server-side engine owns scheduling, transitions, tool permissions, cancellation, and approvals. The canvas describes a workflow; it cannot grant permissions or directly execute privileged actions.

Implement a narrow deterministic graph runner and a bounded agent node. Do not introduce a second competing orchestration engine. Reassess a framework such as LangGraph only if a concrete requirement makes the custom implementation materially more complex; record that decision before adopting it.

Start with one active worker and sequential execution. SQLite is a local/single-host choice, not a promise of distributed scale. A future hosted multi-user deployment requires a fresh concurrency and persistence review.

## 4. Provider strategy and spending controls

### Three execution modes

1. Fixture mode: versioned deterministic responses and tool requests for development and tests. Requires no model service. Clearly label all fixture runs.
2. Local mode: connect through the backend to an operator-configured Ollama instance. Model choice depends on hardware and measured task performance.
3. Remote mode: connect through the backend using the operator's own credentials. Implement one adapter against an actual documented API first, then add other providers as needed. An API described as compatible may still differ in tool calling, streaming, schemas, and usage reporting.

The application must start without any model key or local model installation. Workflow, canvas, persistence, and approval development must remain possible in fixture mode.

### Provider contract

Normalize messages, structured-output requests, tool definitions, tool results, model identity, usage, and errors. Support cancellation and timeouts. Stream user-visible output/events where supported; do not depend on hidden model reasoning.

Each adapter advertises capabilities: tool calls, structured outputs, streaming, embeddings, and usage reporting. Reject unsupported configurations or use an explicitly selected alternative. Never silently downgrade capabilities or switch providers.

Store the provider, model identifier, relevant generation settings, and available model revision/digest with each run. This improves traceability but does not make model output perfectly reproducible.

### Credentials and limits

- Initially reference server environment secrets; do not implement a database credential vault prematurely.
- Never send provider credentials to the browser, include them in workflow exports, or log them in traces.
- Add a connection-test action that clearly states it may make a billable request.
- Require explicit operator configuration before enabling remote inference. No automatic local-to-cloud fallback.
- Set maximum input size, output allowance, tool calls, run duration, and concurrent model requests.
- Track usage when reported. Display unknown cost as unknown, not zero.
- Monetary budgets are estimates unless backed by reliable provider accounting. Use provider-side limits where available; application estimates cannot guarantee a perfect billing cutoff.
- Treat free quotas as optional conveniences, not architecture dependencies. Handle quota exhaustion explicitly.
- Review model licensing before redistributing weights. Do not bundle model weights in the application.

Real model integration is complete only after a real inference smoke test. Fixture tests alone do not establish AI quality. If neither suitable local hardware nor remote access is available, label real inference validation as pending while continuing non-model work.

## 5. Core data contracts

| Entity | Essential data |
| --- | --- |
| Workflow | Stable ID, name, editable draft, current published version |
| WorkflowVersion | Immutable graph, node configuration, input/output contract, referenced agent versions |
| Agent / AgentVersion | Instructions, provider/model settings, permitted tools, knowledge references, output schema, limits |
| Run | Version references, input, status, timestamps, cancellation request, result, execution mode |
| StepRun | Node identity, attempt, status, resolved inputs, output, timing, typed error |
| RunEvent | Run ID, monotonically ordered sequence, event type, redacted payload |
| ToolCall / ActionAttempt | Tool, validated arguments, authorization, action identity, outcome, external reference |
| Approval | Exact proposed payload/version, decision, operator, timestamps, edited replacement if any |
| Record | Type, structured fields, revision, related runs and review decisions |
| KnowledgeDocument / Chunk | Source identity/version, content hash, text, source location, indexing state |
| TestCase / EvaluationRun | Input, assertions, fixture dependencies, candidate version, results |

Use explicit schema versions and database migrations. Separate visual layout from executable behavior. Published workflows pin agent versions and knowledge revisions; do not silently substitute newer definitions during a run.

## 6. Execution semantics

Run states: queued, running, awaiting approval, succeeded, failed, cancelled, and needs attention.

Step states: pending, running, awaiting approval, succeeded, failed, skipped, cancelled, and uncertain.

- A conditional node selects a path; the unused branch is skipped. Initially reject unsupported branch joins and ambiguous fan-in rather than guessing their meaning.
- Persist scheduling decisions and results transactionally. Use a worker ownership token/lease so accidental duplicate worker starts cannot claim the same job.
- Keep tool-call histories and completed results when continuing an agent step. Do not restart an interrupted agent from scratch if that could repeat an action.
- On restart, completed steps remain completed. An interrupted read may be retried according to policy; an interrupted write with no confirmed result becomes uncertain.
- Internal record writes use unique action identities and transactions to prevent duplicate application.
- External writes require endpoint-specific idempotency or reconciliation. Otherwise stop for human review after an ambiguous result. Do not promise universal exactly-once execution.
- Cancellation stops future steps and requests abort of active work. It cannot undo an external action that already happened.
- Approvals authorize the exact payload shown. Edits invalidate prior approval. Repeated approval requests cannot repeat the approved action.
- Evaluation mode substitutes side-effecting tools with fixtures and uses isolated test records. It must not gain live write credentials.

## 7. Security baseline

- Bind to loopback by default. Do not expose the development API on the public internet.
- Bootstrap operator access using a secret outside the repository; use authenticated sessions, secure session handling, restrictive origin checks, and CSRF protection as applicable.
- Keep the local inference service private. The browser talks to the application backend, not directly to privileged tools or provider credentials.
- Validate tool arguments on the server and enforce permission allowlists outside the model.
- Treat retrieved content and tool output as untrusted data, never authorization to perform new actions.
- Restrict HTTP tools to approved destinations and schemes; validate redirects and resolved addresses. Local development fixtures require an explicit narrow exception, not unrestricted private-network access.
- Bound upload size, paths, output size, request duration, and agent iterations.
- Redact sensitive fields from logs, traces, exports, and test fixtures. Do not capture hidden model reasoning.
- Keep secrets outside the database for the first release; credential-vault encryption is a separate future design task.
- Public or shared deployment is gated on TLS, hardened authentication, rate limits, dependency review, backup/restore testing, and a deployment security review. Multi-user isolation requires additional work beyond this release.

## 8. Demonstration scenario

Supplier catalogue preparation:

1. Import a CSV into local records with deterministic validation.
2. Select a record and manually start its workflow.
3. Retrieve relevant store guidelines from a small text collection.
4. Ask a bounded agent to draft a structured listing with source references.
5. Validate required fields and flag missing or conflicting specifications.
6. Show proposed changes and evidence for operator review.
7. Apply the approved change to the record and save an output artifact.

Demonstrate incomplete input, conflicting guidelines, malformed model output, provider unavailability, an unauthorized tool request, approval rejection, and a restart during review. Use fictional or sanitized data.

## 9. Milestones and acceptance gates

### M0 — Contracts and repository setup

- Create the separate repository only after its location is selected.
- Scaffold the workspace, linting, type checks, tests, and migration mechanism.
- Specify node schemas, state transitions, typed errors, provider capabilities, and one sample graph.
- Add schema tests for missing references, malformed node configuration, cycles, and unsupported joins.

Done when: clean setup and contract tests pass without a database service, provider key, or model download.

### M1 — Persisted deterministic runner

- Implement manual trigger, mapping, condition, and output nodes.
- Add database migrations, run creation, worker claiming, persisted events, and cancellation.
- Add a minimal history/detail interface. Build from a saved graph definition before visual editing.

Done when: a sample record follows the correct branch, preserves results across restart, and rejects duplicate execution claims. Failures include useful node-level errors.

### M2 — Visual workflow authoring

- Add the canvas, palette, configuration panel, validated edges, and input mapping UI.
- Save/reopen drafts and publish immutable versions.
- Display execution progress from persisted events; reconnect using the last observed sequence.

Done when: a user builds M1's graph visually, publishes it, and runs it. Editing the draft cannot alter an in-progress run or its historical configuration.

### M3 — Provider-independent AI and agents

- Implement the fixture provider first, then local and one remote adapter.
- Add agent configuration/versioning and structured generation before tool-use loops.
- Add bounded tool use with read-only record lookup and guideline retrieval.
- Implement capability checks, cancellation, usage display, secret redaction, and explicit remote opt-in.

Done when: fixture tests cover every failure category; a real available provider completes a smoke test; unavailable models and quotas produce clear errors. Record unavailable live-provider validation as pending, never passed.

### M4 — Approvals and safe actions

- Implement proposed record updates, approval queue, payload preview, approve/reject/edit, and durable pauses.
- Add action identities, transactional internal writes, and restart reconciliation.
- Test uncertain external outcomes against a controlled local HTTP fixture service.

Done when: a paused run resumes after restart, repeated approval cannot duplicate the write, changed payloads require reapproval, and an ambiguous external write pauses instead of retrying blindly.

### M5 — Records and grounded knowledge

- Add CSV import, record list/detail, source import, source versions, chunks, and local text retrieval.
- Add source references to outputs and evidence views to review screens.
- Begin with lexical retrieval; add local embeddings only after a small retrieval evaluation demonstrates their value. Do not mislabel lexical-only retrieval as hybrid vector search.

Done when: the catalogue scenario works end-to-end, sources are inspectable, absent information is flagged, and old runs retain the source versions they used.

### M6 — Evaluations and release inspection

- Add saved cases, schema/property assertions, fixture substitution, and candidate/current comparison.
- Include at least 20 representative and adversarial cases.
- Assert required fields, valid source references, branch choice, and forbidden-action behavior.
- Use human inspection for semantic quality that deterministic assertions cannot establish. Avoid adding a paid model judge as a requirement.

Done when: intentional prompt and mapping regressions are detected, test mode cannot write to live destinations, and results identify the exact tested version. Report real-model quality separately from fixture correctness.

### M7 — Portfolio release and self-host packaging

- Polish empty/error/loading states, keyboard navigation, and the end-to-end demonstration.
- Document installation, environment variables, local/remote model setup, backups, and recovery.
- Optionally add a container image after native setup works; no managed service is required.
- Create a sanitized recorded walkthrough and clearly labeled interactive replay for the portfolio.
- Publish limitations, test results, and architecture decisions. Do not imply that replay data is live inference.

Done when: a second developer can start fixture mode without purchases; documented live inference works with a suitable operator-supplied model; backup/restore passes; the demonstration includes a real failure-and-recovery path.

## 10. Initial application screens

1. Workflows: drafts, published versions, run action, and recent history.
2. Workflow editor: canvas, palette, node configuration, validation errors, and run panel.
3. Agents: configuration, provider/model capabilities, tools, output contract, and test input.
4. Runs: statuses and detailed ordered step/tool events with source references.
5. Approvals: pending actions, exact diffs, evidence, and decision controls.
6. Records and knowledge: imported data, source versions, indexing status, and retrieval testing.
7. Settings: model endpoints, credential references/status, limits, and execution mode.

Add evaluation screens at M6. Do not spend early milestones building dashboards with invented metrics.

## 11. Credit-efficient development process

- Work in bounded tasks with named files/modules, exclusions, and acceptance tests.
- Keep a short decision log and a milestone status file; read those before rediscovering context.
- Reuse shared validation schemas across UI, API, engine, and fixtures.
- Exercise most behavior with deterministic fixtures. Run real inference only for deliberate smoke tests and quality checks.
- Run focused tests while changing a component and the complete relevant suite at milestone boundaries.
- End each task with changed files, verified behavior, unresolved failures, and the next bounded task.
- Never mark fixture success as production readiness or claim a feature exists because its screen exists.
- Defer aesthetic redesign until the vertical slice works; use one relevant frontend design skill during implementation, not several overlapping design passes.
- Do not benchmark many providers, download several large models, or research every hosting platform before the product needs them.

No calendar estimate is locked in because weekly availability is unknown. Track progress by acceptance gates rather than unsupported completion dates.

## 12. Expansion after the core release

Priority order:

1. Schema-driven workflow forms and record views: a minimal mini-app publishing capability.
2. Reusable subflows and a small set of production HTTP connectors with documented action semantics.
3. Schedules and authenticated webhooks, including offline/missed-trigger handling.
4. Knowledge freshness/dependency tracking and reviewed API-to-connector generation.
5. Shadow releases and an evidence-based debugging assistant that proposes tested patches.
6. Multi-user deployment, billing, private execution workers, and additional model providers when demand justifies them.

Commercialization starts with observing real developers use the product. No revenue, conversion, or pricing assumptions are prerequisites for the MVP.

## 13. Open items and next action

- Repository name: `loomrail`. Proposed location: `/Users/prizesh/code/loomrail`; confirm the location before scaffolding. Keep the existing portfolio application untouched.
- RAM and available disk: affect local model choice, not the architecture.
- Existing provider access: optional; do not buy credits or ask for secret values in chat.
- Weekly time availability: optional for scheduling; does not block contract design.

Next implementation task: M0, followed by a tiny persisted deterministic execution in M1. Do not start by building all seven screens.

## 14. Reference baseline

These support the architectural context; Sentinel documentation is not a source-code audit or proof of reliability.

- [Sentinel provider configuration](https://sentinel-ams.netlify.app/docs/environment)
- [Sentinel fleet execution](https://sentinel-ams.netlify.app/docs/fleets)
- [Sentinel knowledge configuration](https://sentinel-ams.netlify.app/docs/knowledge)
- [Sentinel run records](https://sentinel-ams.netlify.app/docs/runs)
- [Sentinel self-hosting claim](https://sentinel-ams.netlify.app/)
- [React Flow core and license](https://reactflow.dev/)
- [Vite guide](https://vite.dev/guide/)
- [Fastify](https://fastify.dev/)
- [SQLite deployment guidance](https://www.sqlite.org/whentouse.html)
- [Ollama local/cloud configuration](https://docs.ollama.com/faq)

Sentinel's exact backend framework and deployment topology have not been independently verified. This project borrows the separation of platform, models, and infrastructure, not an assumed copy of its private implementation.
