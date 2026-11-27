# Production cycle 1: OpenZeppelin/ethernaut (pre-registration)

This directory freezes the answer key for the first research cycle in the production workspace, **before** any analysis of the target.
The run itself needs approvals A26 (one temporary worker) and A34 (one research run); neither is given yet.

- **Target:** `OpenZeppelin/ethernaut` at commit `d05643a40aa98c45d66247c69ffceab8f44dd8cb` (tree `481488182d37…`, 2025-11-19).
  This was the default branch (`master`) head on 2026-11-27. Branch `main` points elsewhere and is not used.
- **Answer key:** `expected-findings.json`:
  - 14 expected entries in the analyser's classes;
  - 29 levels whose intended flaw is outside them (reported, never scored as misses);
  - 22 keys pre-listed for manual adjudication if they are flagged.
- **Snapshot boundary:** run input `excludePathPrefixes: ["client", "contracts/out", "contracts/test", "contracts/src/attacks"]`.
  The deployed planning code (`buildPlan`, commit `837aeb9`) gives this result on the commit's tree:
  - 1,381 manifest rows, of which 124 files are stored (252,069 bytes);
  - 1,249 rows excluded by policy, 6 submodules, 1 symlink and 1 oversize file, all listed but not stored;
  - 102 Solidity files analysed, each listed with its git blob id.
- **Hashes:** `SHA256SUMS` (`sha256sum -c SHA256SUMS`). The commit that adds this directory is the freeze point. It must be older than the run's `created_at`.
- **Production checks:** `production-precheck.md`.

## Exposure

This is an exposure-qualified evaluation. The cycle proves that the system operates; it does not measure detection ability.
- **Code-blind:** no Ethernaut code appears in any AgentSmith corpus, fixture, test or analyser source.
- **Pattern-familiar:** the analyser was developed on the same textbook patterns.
- **Answer key from the same model family:** the analyser and this key were both written by Claude-family sessions, which very likely saw Ethernaut in training.

The key can be checked independently against Ethernaut's own `contracts/test` and `contracts/src/attacks`. Both were excluded from the snapshot and not used to write the key.
