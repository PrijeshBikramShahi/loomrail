# Loomrail

A single-operator workflow and agent workspace. Build a visual workflow, pin an agent and its knowledge, inspect persisted execution, review an exact proposal, and apply a local record update. Fixtures require no model service or paid account. The portfolio repository remains untouched.

The implementation covers M0–M7's fixture path. **Real Ollama/OpenAI inference and semantic quality are not yet validated** because no suitable service or credentials were available. This is a local portfolio MVP, not a public multi-tenant service. See [milestone status](docs/STATUS.md), [limitations](docs/LIMITATIONS.md), and the original [implementation plan](docs/AI_AUTOMATION_PLATFORM_PLAN.md).

## Start locally

Use Node.js 24+ and npm. SQLite is embedded through `node:sqlite`; there is no database service. Some Node releases print an experimental SQLite warning.

```sh
npm ci
npm run build
npm run operator:init
npm start
```

Open **http://127.0.0.1:3001**. `npm start` launches the API, built web UI, and separate worker. Ctrl-C stops both processes. Keep this port private.

`operator:init` creates a private 0600 key at `~/.config/loomrail/operator.key`, outside the repository, without printing or overwriting it. Open that file locally and copy its contents into the sign-in form. Do not commit the key or paste it into chat. A custom key path must also resolve outside this repository.

For development, run these in three terminals instead:

```sh
npm run dev:server
npm run worker
npm run dev
```

The development UI is **http://127.0.0.1:5173**, proxying `/api` to port 3001. Rebuild shared packages with `npm run build:packages` after contract/provider changes, and restart the worker after execution changes. Do not run development and packaged API servers on the same port simultaneously.

## Try the catalogue

1. Open **Records & knowledge**. Validate and import the fictional CSV already in the form.
2. Save the supplied fictional listing guidelines as a source revision.
3. Create the catalogue workflow. This publishes a fixture agent pinned to those sources and a six-node workflow.
4. Choose **Use record as run input**, select the catalogue workflow, and run it.
5. Open **Approvals**. Inspect the original record, proposed changes, model output, and retrieved source chunks. Missing prices are explicitly flagged.
6. Approve, reject, or save edited fields for a separate review. Approval applies the exact saved payload once and produces a downloadable JSON artifact.
7. Open **Evaluations**, add the 24-case catalogue suite, select the catalogue version and cases, and run it. Tests use isolated records and fixtures only.

The supplied **Supplier catalogue** workflow also demonstrates deterministic branching: a positive price takes the ready branch, zero takes the review branch, and a missing price fails with a node error. The visual editor supports incomplete saved drafts and validates complete graphs before publication.

A [recorded fixture replay](http://127.0.0.1:3001/replay.html) includes database reopening during review, rejection, and malformed model output. It is a saved, read-only recording, not live AI. See the [walkthrough](docs/demo/WALKTHROUGH.md).

## Providers

- **Fixture:** built-in deterministic models such as `tool-demo-v1`, `echo-v1`, and deliberately failing fixtures. No network or inference.
- **Ollama:** install and run Ollama separately, then choose a suitable locally available model identifier in an agent. The operator supplies hardware and weights; weights are not bundled. Keep the service private. Default endpoint: `http://127.0.0.1:11434`.
- **OpenAI:** explicitly set `LOOMRAIL_REMOTE_ENABLED=true` and `OPENAI_API_KEY` on the API and worker processes. Select `openai` and an operator-chosen model supporting Chat Completions tools and JSON Schema. Credentials never go in an agent definition. Tests of published remote agents may be billable.

- **OpenRouter free models:** set `LOOMRAIL_REMOTE_ENABLED=true` and `OPENROUTER_API_KEY` on the backend, then choose OpenRouter in Agents. Nemotron 3 Super is the default and supports native JSON Schema plus tools; Laguna S 2.1 remains available with explicitly selected prompted JSON. The adapter allowlists exact free model IDs, requires zero token prices, and disables provider fallback. Free-provider data policies apply, so use fictional data for smoke tests.

Agents & providers shows capability and configuration status. Its test action queues the saved agent version and records the exact provider/model/settings, available revision, tool requests, usage, and errors. The app never switches providers automatically. Unsupported model settings fail explicitly. Token counts and cost can be unknown; application limits are not guaranteed monetary budgets.

A provider is validated only after a deliberate real inference test succeeds. See [provider setup and smoke protocol](docs/PROVIDERS.md).

## Configuration

Environment variables are read directly; `.env` is not automatically loaded. Configure API and worker consistently.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOOMRAIL_PORT` | `3001` | Loopback API port |
| `LOOMRAIL_ORIGIN` | Dev: `http://127.0.0.1:5173`; launcher: API origin | Exact trusted loopback UI origin |
| `LOOMRAIL_DATA_DIR` | Repository `data/` | Absolute data directory, shared by API and worker |
| `LOOMRAIL_OPERATOR_SECRET_FILE` | `~/.config/loomrail/operator.key` | Private operator key outside repository |
| `LOOMRAIL_SERVE_WEB` | unset | `true` serves the built web UI; set by launcher |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Operator-configured Ollama endpoint |
| `LOOMRAIL_REMOTE_ENABLED` | unset | Must equal `true` for OpenAI or OpenRouter inference |
| `OPENAI_API_KEY` | unset | Backend-only OpenAI credential |
| `OPENROUTER_API_KEY` | unset | Backend-only OpenRouter credential |
| `LOOMRAIL_ENABLE_HTTP_FIXTURE` | unset | Enables controlled HTTP test actions only |
| `LOOMRAIL_HTTP_FIXTURE_URL` | unset | Exact `http://127.0.0.1:<port>/actions` test endpoint |

The HTTP fixture is a narrow test exception, not a general HTTP connector. It is not exposed in the normal editor palette. Production external connectors remain deferred.

## Checks and maintenance

```sh
npm run check
npm run backup -- /absolute/path/new-backup.sqlite
npm run restore -- /absolute/path/backup.sqlite /absolute/path/new-data-directory
```

The suite includes graph validation, API authentication/CSRF, provider failures, worker crash recovery, checkpoints, approval revision checks, atomic actions, a loopback HTTP uncertainty/reconciliation fixture, isolated evaluations, and CLI backup/restore. Loopback fixture tests need permission to bind a local ephemeral port.

Backups use SQLite's online backup API and verify integrity and migration history. They include records, source text, artifacts, and history. Sessions and worker leases are removed from the copy. Restore accepts only a new or empty directory and never overwrites existing data. Stop services before switching `LOOMRAIL_DATA_DIR` to the restored directory; retain the external operator key separately. See [recovery](docs/RECOVERY.md).

Other commands: `npm run db:migrate`, `npm run demo` (original deterministic example), and `npm run demo:record` (regenerate sanitized fixture replay from temporary data).

## Architecture

- `apps/web`: React/Vite, React Flow editor, agents, runs, approvals, records/knowledge, evaluations.
- `apps/server`: Fastify, authenticated commands, SQLite, sequential worker, backup/restore.
- `packages/contracts`: shared versioned Zod contracts and validation.
- `packages/engine`: pure deterministic binding and node evaluation.
- `packages/providers`: explicit fixture, Ollama, and OpenAI adapters with bounded I/O.

Published workflow and agent versions and knowledge chunks are immutable. A global lease fences duplicate workers. Agent requests and tool histories are checkpointed outside network transactions. Internal writes use unique action IDs and database transactions. Ambiguous controlled external writes stop for reconciliation. See [contract semantics](docs/CONTRACTS.md) and [architecture decisions](docs/decisions/).
