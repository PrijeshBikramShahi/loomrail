# Provider configuration and real inference protocol

Fixture mode starts without keys or model services. `tool-demo-v1` performs two read-only tool calls and returns a deterministic listing; `echo-v1` returns its JSON input. Failure fixtures exercise malformed output, unavailable providers, quotas, unauthorized tools, timeouts, output limits, and endless tool requests. These are tests, not AI quality evidence.

## Local Ollama

Install Ollama from its official distribution and choose a model appropriate to your hardware and task. Review its license separately. Start the private service and verify the desired model is installed using Ollama's own tooling. No weights are bundled or automatically downloaded by Loomrail.

Set `OLLAMA_BASE_URL` only on the backend processes if the default `http://127.0.0.1:11434` is unsuitable. Select Ollama in Agents, enter the exact installed model identifier, configure a small schema and limits, and publish. Test the saved version explicitly. The adapter uses `/api/chat`, structured `format`, tool messages, no streaming, and bounded requests. It does not expose hidden reasoning. Model-specific incompatibilities are surfaced as errors.

## Remote OpenAI

Set `LOOMRAIL_REMOTE_ENABLED=true` and `OPENAI_API_KEY` in the API and worker environments. Do not put a key in agent JSON or the browser. Choose a model that supports the requested Chat Completions features. Publish the selected provider/model/settings and deliberately run its test action; it may be billable. Use provider-side account limits where available. The application does not promise a perfect financial cutoff.

The adapter sends `store: false`, explicit structured-output and tool requirements, bounded input/output/time, and abort signals. It never falls back to another provider. A 429 is recorded as quota/rate-limit exhaustion. Cost stays null/unknown; reported token usage is retained.

## OpenRouter free models

Set `LOOMRAIL_REMOTE_ENABLED=true` and `OPENROUTER_API_KEY` in both backend process environments. Restart those processes after changing configuration. Environment files are not loaded automatically. Keep the key out of chat, agent definitions, and source control. Alternatively, save it as `OPENROUTER_API_KEY=...` alongside `LOOMRAIL_REMOTE_ENABLED=true` in the Git-ignored `.env.local` file. To load that file for the smoke test and supersede an old inherited key, use `env -u OPENROUTER_API_KEY -u LOOMRAIL_REMOTE_ENABLED node --env-file=.env.local --import tsx scripts/smoke-openrouter.ts`. For the built application use the same prefix with `scripts/start.mjs` instead; it passes the environment to both API and worker.

Choose OpenRouter in Agents, then select one of the two exact allowlisted free endpoints:

- `nvidia/nemotron-3-super-120b-a12b:free` is the default. Its catalogue metadata advertises tools and native structured output. Loomrail requires every configured read-only tool in bounded rounds, then requests the final JSON Schema response.
- `poolside/laguna-s-2.1:free` advertises tools but not structured output. Its agent version explicitly records `outputMode: prompt_json`; Loomrail includes the schema in the prompt and validates the parsed JSON locally.

The adapter refuses other models, sets maximum prompt and completion prices to zero, disables provider fallback, and uses the fixed OpenRouter HTTPS endpoint. Invalid JSON/schema, invented source IDs, unauthorized tools, and exceeded limits stop the run. No native-schema request is silently downgraded.

Free-model quotas and capacity can limit testing; agent tool loops use multiple requests. Poolside states free-tier inputs and outputs may be used for training. Use fictional data for acceptance tests. Hidden reasoning is excluded from the requested response and is not retained by the adapter.

After building packages, deliberately run the command below with the key already set in the environment. It performs one small JSON test and, only if it succeeds, a bounded catalogue/tool test in an in-memory database. It never opens operator storage or approves a proposal.

```sh
env -u OPENROUTER_API_KEY -u LOOMRAIL_REMOTE_ENABLED \
  node --env-file=.env.local --import tsx scripts/smoke-openrouter.ts \
  --model=nvidia/nemotron-3-super-120b-a12b:free
```

Use `--catalogue-only` to skip the preliminary JSON request. Use `--paced` only when diagnosing provider throttling; it waits 65 seconds before and between calls and does not automatically retry a failure. Normalized evidence is written under `docs/validation/` according to the selected model and mode. These commands make real requests and are not part of the automated suite.

On 2026-10-08, Nemotron completed the fictional catalogue path through both tools and reached approval with all checks passing. Successful responses reported zero cost. Laguna passed JSON and tool calls but repeatedly returned HTTP 429 before final output. See the [Nemotron record](validation/NEMOTRON.md) and [Laguna notes](validation/LAGUNA.md).

## Acceptance record

For each deliberate real smoke test, record provider, model/revision, settings, timestamp, sanitized input, resulting run ID, schema validation outcome, reported usage, and human quality observations. Check structured output first, then read-only tools, then cancellation/error behavior. Use fictional input and existing operator access; do not purchase credits as an implicit setup step.

Current status: OpenRouter/Nemotron passed one complete real-provider catalogue smoke test through the approval boundary. Human review found that one draft acceptable. Ollama/OpenAI remain unverified, and the fixture suite remains the reproducible regression baseline.

Primary API references consulted during implementation:
- https://docs.ollama.com/api/chat
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

OpenRouter references checked for the free-model integration:
- https://openrouter.ai/poolside/laguna-s-2.1:free
- https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free
- https://openrouter.ai/api/v1/models
- https://openrouter.ai/docs/guides/routing/provider-selection
