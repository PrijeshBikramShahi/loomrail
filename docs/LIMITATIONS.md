# Release limitations

- Single operator, workspace, host, and sequential worker. No organization isolation, multi-user roles, billing, public webhooks, schedules, or distributed execution.
- Loopback only. No claim of public deployment readiness. Public/shared deployment needs TLS, hardened identity/access, broader rate limits, security review, and a separate concurrency/isolation design.
- Fixture correctness is tested. OpenRouter/Nemotron completed one real fictional catalogue case with native schema output and tools; this is limited evidence, not a broad semantic-quality guarantee. Ollama/OpenAI inference and local hardware suitability remain unverified. No model weights are bundled or downloaded automatically.
- OpenAI adapter targets documented Chat Completions, not every “compatible” endpoint. Model capabilities vary. Streaming, embeddings, automatic routing, and fallback are unsupported. Cost is unknown; quotas/rate limits are explicit errors.
- OpenRouter is restricted to Nemotron 3 Super free and Laguna S 2.1 free, zero token prices, and no provider fallback. Nemotron uses native JSON Schema; its adapter requires each configured read-only tool before requesting final output. Laguna uses prompted JSON and remained rate-limited before full completion. Free model availability and capability metadata can change.
- JSON Schema support is intentionally bounded: no remote references, regex, recursive schemas, or arbitrary validation code. Tool use is limited to server-authorized record lookup and pinned lexical source search.
- Fixture prompt assertions check required instruction text only. They cannot prove that a real model follows it or that prose is factually good. Source-ID validation proves citation provenance, not semantic support for every sentence.
- Text/Markdown sources: 100 KB each; CSV: 250 KB and 500 rows per import. Lexical retrieval returns up to five matching chunks and can miss synonyms or cross-chunk context. No PDF/OCR, vectors, or hybrid retrieval.
- Graphs are directed trees with one manual trigger, explicit condition branches, and no joins, cycles, or parallel fan-out. The UI exposes six node types.
- Internal record changes are approval-gated and transactional. External support is a controlled loopback fixture only; endpoint-specific production connectors are not implemented. Cancellation cannot undo an already applied external action.
- Interrupted model requests can be billed again if a replacement worker retries before the response was checkpointed. Request and wall-clock budgets still apply; inference is not exactly-once.
- API trace projections redact sensitive field names and configured keys. Operational inputs and model context remain in SQLite so runs can resume. Do not use records or workflow inputs as a credential store. Backups are private operational data, not sanitized exports.
- Recent UI lists are bounded (50 runs, 100 approvals, 20 evaluations, 1000 records). There is no retention policy or large-corpus performance claim.
- Native setup is supported; container packaging is optional and not supplied. CI configuration targets Node 24. See STATUS for environments actually verified.
- The public replay contains generated fictional fixture traces, with no live API access. A recorded browser/video production and an independent second-developer usability trial are not claimed.
