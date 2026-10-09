# 0004 — Checkpointed agents and explicit providers

Agent definitions are immutable and pinned in workflow versions. A single worker serializes model requests. Each request consumes a persisted iteration before network I/O; model responses and read-only tool batches are checkpointed independently. Restarting can retry an interrupted read/model request within the original wall-clock and iteration budget, but does not repeat committed tool batches. Model generation may therefore be billed again after an interrupted request; no exactly-once inference claim is made. Cancellation and lease fencing prevent late responses from mutating completed runs. SQLite transactions never span network calls.

Provider adapters cover deterministic fixtures, operator-configured Ollama, and OpenAI Chat Completions. Chat Completions was selected for its explicit tool-message/schema contract; this does not claim compatibility with arbitrary OpenAI-like services. No provider switching or capability downgrades occur. Streaming and embeddings are unsupported. Model-specific unsupported settings are returned as errors. Environment secrets remain server-side. Remote execution requires both LOOMRAIL_REMOTE_ENABLED=true and OPENAI_API_KEY; testing a published remote agent may incur charges.

Structured output uses a bounded JSON Schema subset (Ajv), excluding references and regular expressions. Read-only tools enforce server-side allowlists and argument schemas. Source citations must reference actually retrieved chunks. Retrieved data never grants tool permissions. Usage is stored where reported; unknown tokens/cost remain null.

Primary documentation consulted on 2026-10-07:
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- https://docs.ollama.com/api/chat

On 2026-10-08, an allowlisted OpenRouter adapter was added with an explicit zero-price ceiling and provider fallback disabled. Model output behavior is stored in the agent version: Nemotron 3 Super free uses native JSON Schema, while Laguna S 2.1 free uses prompted JSON with local validation because its catalogue metadata does not advertise native schema output. OpenRouter credentials follow the same server-only opt-in and redaction rules.

Nemotron initially produced a final response without retrieving its sources; provenance validation rejected it. The adapter now requires every configured read-only tool in separate bounded rounds before requesting schema-constrained final output. A subsequent real run retrieved the record and guideline, returned valid cited JSON, and stopped at approval without changing the record. Laguna passed real JSON and tool calls but repeatedly hit HTTP 429 before final output. Ollama/OpenAI remain unverified, and one passing fictional case does not establish broad model quality.
