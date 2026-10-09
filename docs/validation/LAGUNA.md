# Laguna S 2.1 free validation

Date: 2026-10-08. Provider: OpenRouter. Requested model: `poolside/laguna-s-2.1:free`.

## Result

**Partial live validation passed; full catalogue completion blocked by rate limits.** The initial environment key returned HTTP 401. The operator replaced it in the private, Git-ignored `.env.local`; retries explicitly loaded that file instead of the old inherited key.

- A real JSON request returned exactly `{"ok":true,"name":"Fictional canvas tote","price":24}` and passed local schema validation. OpenRouter reported 127 input tokens, 20 output tokens, and zero cost. Evidence: [initial smoke](laguna-s-live.json).
- Catalogue run `8f2520bf-ba5f-4873-bed0-3ae0e04444ec` successfully executed `record_lookup` for the fictional cup and `guideline_search` for the pinned source. Its tool-call response reported 445 input tokens, 51 output tokens, and zero cost. The following model request returned HTTP 429. Evidence: [catalogue attempt](laguna-s-catalogue.json).
- A final catalogue attempt waited 65 seconds before the first request and still received HTTP 429 with no Retry-After header. Evidence: [paced attempt](laguna-s-paced.json).
- The authenticated account counter reported 50 free requests remaining when checked. This does not establish which upstream/platform rate limit rejected the requests.
- No complete listing was generated, no approval was submitted, and no operator record changed. Semantic quality, complete tool-result continuation, and the full live catalogue path remain unverified. Successful responses' reported cost was zero; failed responses did not supply usage.

The public model catalogue reports zero prompt/completion token pricing and support for tools, tool choice, temperature, token limits, and reasoning controls. It does not advertise JSON Schema output. Loomrail therefore requires explicit prompted-JSON mode; native schema requests are rejected, never silently downgraded.

## Implemented safeguards and tests

- Exact free-model allowlist, zero maximum token prices, and no fallback models/providers.
- Explicit remote opt-in and backend-only key, included in API secret redaction.
- Strict final JSON parsing and local schema validation before the existing provenance and approval checks.
- Tool identities/results preserved across rounds; existing engine allowlists and budgets still apply.
- Provider diagnostics and hidden reasoning excluded from normalized responses.
- Saved evaluations substitute this agent with isolated fixtures and cannot invoke the remote provider.

At that stage, full Node 24 validation passed: lint, typecheck, 129 tests across 19 files, and production build. Network calls in those tests were mocked except the controlled loopback recovery service; this did not change Laguna's incomplete full-catalogue status. The later Nemotron validation is documented separately.

## Next live attempt

The key now authenticates successfully. Retry the documented catalogue-only smoke after provider capacity/quota becomes available. `--paced` introduces a 65-second initial cooldown and spaces model requests without automatically retrying failures. Inspect the actual draft and sources before approving a real record update. The script stops at pending approval and never changes operator records.
