# Specialist probe (dev fixture; not a benchmark, not frozen)

Synthetic contracts in `src/` with six seeded issues and four decoys. The answer key, `answer-key.json`, was written before any
specialist ran: SHA-256 `fe7d094d617743b3773d9dbd0ddec950a75cdedca3202e7ed55cd71921d1d3a4`.

`outputs/` holds:
- the recorded real outputs of attended Claude Code sub-agents (2026-11-27): scope, accounting, paths (v2), assumptions, liveness,
  challenge;
- the effort for each run (`effort.jsonl`), including the path-tracer v1 run stopped by the safety classifier;
- the Slither and P1–P3 baselines.

`challenger-tests/` holds the challenger's local Foundry tests: 7, re-run independently, all passed. The tests in
`engine-attended.integration.test.ts` replay these outputs through the engine.

**Limits:** the bugs are textbook and the fixture was written by the same model family as the specialists. Results here show coverage
of known patterns, not discovery ability. See `docs/specialist-research.md`.
