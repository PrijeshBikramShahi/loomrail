# 0001 — A small deterministic foundation

Date: 2026-10-07
Status: accepted for M0

The selected implementation directory is `/Users/prizesh/code/loomrail`, matching the approved plan. This is a separate npm workspace and Git repository. No product dependency or implementation file belongs in the portfolio application.

Use React/Vite, Fastify, TypeScript, and Zod, with private ESM packages and compiled package exports. Dependency versions are pinned in one root lockfile. TypeScript 5.9.3 is deliberately selected within the installed typescript-eslint peer range rather than the newer incompatible TypeScript major. No React Flow dependency is necessary until the editor milestone.

Use built-in `node:sqlite` with a Node 24 minimum to avoid a separate database service or native addon installation. The API remains experimental in some supported Node releases; keep database access behind the server database module. Migrations are consecutive, checksum-verified, and applied under `BEGIN IMMEDIATE` with rollback. Enable foreign keys, a busy timeout, and WAL. No distributed-concurrency claim is made.

The reference evaluator exists to verify the graph semantics before durable worker scheduling. It is synchronous, bounded, server/CLI-only, and has no side effects. Do not wire it to a run endpoint and call that persisted execution. M1 must add transactions, leases, run/step/event storage, cancellation, recovery, and authentication before exposing commands.

Provider work is limited to shared interfaces and fail-closed capability checks. Real adapters, output-schema enforcement, asynchronous limits, secrets, and AI quality checks remain M3. A deterministic graph demonstration is not fixture-provider inference.

## Web preview direction

Use one quiet workflow page centered on the actual sample graph. The visual emphasis is the numbered preparation path and its two explicit outcomes, not dashboard metrics or placeholder navigation. Palette: canvas `#f4f6fc`, surface `#ffffff`, ink `#202b49`, action `#3555c7`, muted `#586680`, border `#dce2ef`. Use Avenir Next with Segoe UI/system fallbacks and monospace only for JSON. Align content left, keep the graph above the sample input and current limitations, and stack on narrow screens.

The initial review removed proposed multi-screen navigation and run controls because those behaviors are not implemented. The page is explicitly read-only; the engine stays outside the browser. Follow the frontend-design skill's focus and accessibility guidance without spending M0 on a full aesthetic redesign.
