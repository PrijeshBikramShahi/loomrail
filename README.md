# Loomrail

**A local-first workspace for building, running, and supervising AI agent workflows.**

Design a workflow visually, pin an agent to versioned knowledge, inspect every persisted step of execution, review the exact proposal an agent makes, and apply the change to your records only when you approve it.

- **You stay in control.** Nothing is written until you approve the exact saved payload, and it is applied once.
- **Everything is inspectable.** Runs, tool requests, retrieved sources, and model output are persisted and replayable.
- **Local and private.** Your data lives in an embedded SQLite database on your machine. No hosted service or account is required.
- **Bring your own model.** Run deterministic fixtures offline, local models through Ollama, or remote models through OpenAI or OpenRouter free models.

## Current release

Loomrail is an early release built for a single operator running it locally.

| | Status |
|---|---|
| **Verified** | The full fixture path: visual workflow editor, agent pinning, persisted runs, approval review, exact-payload apply, evaluations, and backup/restore, covered by the automated suite. |
| **Not yet validated** | Real inference through Ollama, OpenAI, and OpenRouter, and semantic output quality. A provider is treated as validated only after a deliberate real inference test succeeds (see the [provider setup and smoke protocol](docs/providers.md)). |
| **Not supported** | Multi-user or multi-tenant deployment, public hosting, and production external connectors. Keep the API port private. |

A recorded fixture replay shows database reopening during review, rejection, and malformed model output. It is a saved, read-only recording, not live AI. See the [walkthrough](docs/walkthrough.md).

## Quick start

Requires Node.js 24+ and npm. SQLite is embedded through `node:sqlite`, so there is no database service to run. Some Node releases print an experimental SQLite warning.

```bash
npm ci
npm run build
npm run operator:init
npm start
```

Open http://127.0.0.1:3001. `npm start` launches the API, the built web UI, and a separate worker. Ctrl-C stops both processes.

`operator:init` creates a private `0600` key at `~/.config/loomrail/operator.key`, outside the repository. It never prints or overwrites the key. Open the file locally and copy its contents into the sign-in form. Never commit the key or paste it into chat. A custom key path must also resolve outside this repository.

### Development mode

Run these in three terminals:

```bash
npm run dev:server
npm run worker
npm run dev
```

The dev UI is http://127.0.0.1:5173 and proxies `/api` to port 3001.

- Rebuild shared packages with `npm run build:packages` after contract or provider changes.
- Restart the worker after execution changes.
- Do not run the development and packaged API servers on the same port at once.

## Guided tour: supplier catalogue review

The tour uses fictional sample data and the built-in fixture models, so it needs no model service or paid account.

1. Open **Records & knowledge**. Validate and import the sample CSV already in the form.
2. Save the supplied listing guidelines as a source revision.
3. Create the catalogue workflow. This publishes a fixture agent pinned to those sources and a six-node workflow.
4. Choose **Use record as run input**, select the catalogue workflow, and run it.
5. Open **Approvals**. Inspect the original record, proposed changes, model output, and retrieved source chunks. Missing prices are explicitly flagged.
6. Approve, reject, or save edited fields for a separate review. Approval applies the exact saved payload once and produces a downloadable JSON artifact.
7. Open **Evaluations**, add the 24-case catalogue suite, select the catalogue version and cases, and run it. Evaluations use isolated records and fixtures only.

The *Supplier catalogue* workflow also shows deterministic branching: a positive price takes the ready branch, zero takes the review branch, and a missing price fails with a node error. The visual editor supports incomplete saved drafts and validates complete graphs before publication.

## Providers

Loomrail never switches providers automatically. Unsupported model settings fail explicitly. Token counts and cost can be unknown, and application limits are not guaranteed monetary budgets.

| Provider | Setup | Notes |
|---|---|---|
| **Fixture** | None | Built-in deterministic models such as `tool-demo-v1`, `echo-v1`, and deliberately failing fixtures. No network or inference. |
| **Ollama** | Install and run Ollama separately, then choose a locally available model identifier in an agent. | You supply the hardware and weights; none are bundled. Keep the service private. Default endpoint: `http://127.0.0.1:11434`. |
| **OpenAI** | Set `LOOMRAIL_REMOTE_ENABLED=true` and `OPENAI_API_KEY` on the API and worker. | Choose a model that supports Chat Completions tools and JSON Schema. Credentials never go in an agent definition. Tests of published remote agents may be billable. |
| **OpenRouter (free models)** | Set `LOOMRAIL_REMOTE_ENABLED=true` and `OPENROUTER_API_KEY` on the backend, then choose OpenRouter in Agents. | Nemotron 3 Super is the default and supports native JSON Schema plus tools. Laguna S 2.1 is available with explicitly selected prompted JSON. The adapter allowlists exact free model IDs, requires zero token prices, and disables provider fallback. Free-provider data policies apply, so use fictional data for smoke tests. |

**Agents & providers** shows capability and configuration status. Its test action queues the saved agent version and records the exact provider, model, and settings, available revision, tool requests, usage, and errors.

## Configuration

Environment variables are read directly; `.env` is not loaded automatically. Configure the API and worker consistently.

| Variable | Default | Meaning |
|---|---|---|
| `LOOMRAIL_PORT` | `3001` | Loopback API port |
| `LOOMRAIL_ORIGIN` | Dev: `http://127.0.0.1:5173`; launcher: API origin | Exact trusted loopback UI origin |
| `LOOMRAIL_DATA_DIR` | Repository `data/` | Absolute data directory, shared by API and worker |
| `LOOMRAIL_OPERATOR_SECRET_FILE` | `~/.config/loomrail/operator.key` | Private operator key outside the repository |
| `LOOMRAIL_SERVE_WEB` | unset | `true` serves the built web UI; set by the launcher |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Operator-configured Ollama endpoint |
| `LOOMRAIL_REMOTE_ENABLED` | unset | Must equal `true` for OpenAI or OpenRouter inference |
| `OPENAI_API_KEY` | unset | Backend-only OpenAI credential |
| `OPENROUTER_API_KEY` | unset | Backend-only OpenRouter credential |
| `LOOMRAIL_ENABLE_HTTP_FIXTURE` | unset | Enables controlled HTTP test actions only |
| `LOOMRAIL_HTTP_FIXTURE_URL` | unset | Exact `http://127.0.0.1:<port>/actions` test endpoint |

The HTTP fixture is a narrow test exception, not a general HTTP connector, and it is not shown in the normal editor palette. Production external connectors are on the roadmap but not yet available.

## Reliability and data safety

- Published workflow versions, agent versions, and knowledge chunks are immutable.
- A global lease fences duplicate workers.
- Agent requests and tool histories are checkpointed outside network transactions, so a crash resumes from the last checkpoint.
- Internal writes use unique action IDs and database transactions.
- Ambiguous controlled external writes stop for reconciliation rather than retrying blindly.

### Backup and restore

```bash
npm run backup -- /absolute/path/new-backup.sqlite
npm run restore -- /absolute/path/backup.sqlite /absolute/path/new-data-directory
```

Backups use SQLite's online backup API and verify integrity and migration history. They include records, source text, artifacts, and history. Sessions and worker leases are removed from the copy. Restore accepts only a new or empty directory and never overwrites existing data. Stop services before switching `LOOMRAIL_DATA_DIR` to the restored directory, and back up the operator key separately. See [recovery](docs/recovery.md).

## Development and testing

```bash
npm run check
```

The suite covers graph validation, API authentication and CSRF, provider failures, worker crash recovery, checkpoints, approval revision checks, atomic actions, a loopback HTTP uncertainty/reconciliation fixture, isolated evaluations, and CLI backup/restore. Loopback fixture tests need permission to bind a local ephemeral port.

Other commands: `npm run db:migrate`, `npm run demo` (a deterministic example run), and `npm run demo:record` (regenerates the sanitized fixture replay from temporary data).

## Architecture

- `apps/web`: React/Vite UI with a React Flow editor, agents, runs, approvals, records and knowledge, and evaluations.
- `apps/server`: Fastify API with authenticated commands, SQLite, a sequential worker, and backup/restore.
- `packages/contracts`: shared, versioned Zod contracts and validation.
- `packages/engine`: pure, deterministic binding and node evaluation.
- `packages/providers`: explicit fixture, Ollama, OpenAI, and OpenRouter adapters with bounded I/O.

## Documentation

- [Milestone status and limitations](docs/milestones.md)
- [Original implementation plan](docs/plan.md)
- [Provider setup and smoke protocol](docs/providers.md)
- [Contract semantics](docs/contracts.md)
- [Architecture decisions](docs/decisions.md)
- [Walkthrough](docs/walkthrough.md)
- [Recovery](docs/recovery.md)
