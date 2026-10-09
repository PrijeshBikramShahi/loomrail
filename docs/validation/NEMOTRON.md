# Nemotron 3 Super free validation

Date: 2026-10-08. Provider: OpenRouter. Model: `nvidia/nemotron-3-super-120b-a12b:free`. Output mode: native JSON Schema.

## Result

**The real-provider catalogue smoke test passed.** Run `0501b8e5-fa9e-47f2-a007-1ed874bd07b8` used an isolated in-memory database containing only a fictional ceramic cup and fictional listing guidance. It completed `record_lookup`, completed `guideline_search`, returned schema-valid JSON, passed citation provenance checks, and stopped durably at `awaiting_approval`. It did not automatically approve or change the record.

The proposed fields were:

- title: `Fictional ceramic cup`
- description: `A ceramic cup.`
- price: `null`
- flags: `missing_price`
- source: the exact retrieved fictional guideline chunk

Human review found the draft concise, consistent with the supplied facts, correctly cautious about the missing price, and free of invented dimensions, capacity, origin, or certifications. This is an acceptable result for this one test case. It does not establish quality on other records, longer instructions, conflicts, adversarial retrieval, or changing free-provider capacity.

OpenRouter reported three successful requests totaling 1,371 input tokens and 867 output tokens, with estimated cost of zero. Normalized evidence is saved in [nemotron-super-catalogue.json](nemotron-super-catalogue.json). The earlier rejected attempt is preserved in [nemotron-super-initial-tools.json](nemotron-super-initial-tools.json).

## Behavior corrected during validation

The first live run skipped the tools and invented a source identifier. Loomrail's existing provenance check rejected it with `INVALID_OUTPUT`, so the proposal never reached approval. Native-schema OpenRouter agents now require each configured read-only tool before requesting the final schema-constrained response. Completed tools are identified by persisted tool-result call IDs, preventing a model from satisfying the requirement merely by naming a tool.

The adapter keeps the exact free model allowlist, requires zero prompt/completion prices, disables fallback providers, excludes reasoning from the requested response, and locally validates the final JSON again. Saved evaluations still substitute deterministic fixtures and cannot access the remote credential.

After the final integration changes, the complete Node 24 release check passed: lint, typecheck, 131 tests across 19 files, and the production build.

Browser QA confirmed the OpenRouter selector defaults to Nemotron, switches explicitly between native-schema and prompted-JSON descriptions, remains keyboard reachable, and does not introduce horizontal overflow at the narrow tested viewport. No browser console warnings or errors were recorded.
