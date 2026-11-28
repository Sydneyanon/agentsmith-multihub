# Security tooling assessment: Slither, Aderyn, Foundry (assessment only; nothing installed or run)

Basis: general knowledge of these tools, NOT verified here (this environment has no network access to their sources and none of them is installed). Every row marked "verify" must be confirmed before any adoption. No dependency, service or spend is requested.

| | Slither | Aderyn | Foundry (forge) |
|---|---|---|---|
| What it gives | Static detectors, call/data-flow facts | Static detectors, fast | Compile, run tests, fuzz, invariant tests, local EVM and PoC execution |
| Needs | Python, a matching `solc` (version per pragma), project compile through crytic-compile (verify) | Rust binary, project root and a compile step (verify) | Foundry toolchain, `solc` (it can download compilers: network) |
| Runs repository code? | Compiling a Hardhat project executes its JavaScript config; Foundry projects invoke `forge` | Same compile concern | `forge test` executes repository-supplied Solidity in the EVM; cheatcodes such as `ffi` and file access can touch the host if the repository's `foundry.toml` enables them; fork tests use RPC |
| Output to ingest | JSON: detector id, impact, confidence, source-mapping with files and lines (verify exact schema) | JSON / SARIF / markdown (verify) | Test results, traces, gas, counterexamples |
| Licence | AGPL-3.0 (verify) | verify | MIT / Apache-2.0 (verify) |

## How output would become evidence-linked leads
1. Run on an immutable sealed snapshot (5.2), never on a mutable checkout; record tool name, version, command line, and the snapshot manifest hash as inputs.
2. Map each tool finding's file and line range to an evidence span in that snapshot; findings whose lines do not resolve are dropped and counted.
3. Store as hypotheses with generator `deterministic_rule` and id `<tool>@<version>:<detector>`, never as confirmed findings; tool confidence is stored as a claim, not as probability.
4. Reconcile with the structural specialists (same function and class = corroboration; tool-only or specialist-only = flagged as such). Disagreement is data for the evaluation, not a vote.

## Isolation and resource requirements (a design to be approved, not built)
- A disposable sandbox per run: no network, no secrets, non-root, read-only source mount, CPU, memory, process and wall-clock limits, a scratch directory deleted afterwards.
- Compilers supplied as pinned, hash-verified binaries baked into the image (no downloads at run time).
- Repository build configuration is untrusted: force `ffi = false`, empty `fs_permissions`, no remapping or dependency fetch, ignore repository hooks and scripts. Where a Hardhat config would run JavaScript, do not build with it; compile through a controlled path.
- Fork-mode tests stay disabled until an RPC policy exists (it is network access and possible spend).

## Recommended order (needs your approval before any of it)
1. **Foundry first, for local fixtures only**: it provides the compile-and-execute ground truth that would verify the labels in `eval/` and the validator's verdicts, and it is the route to a reproducible proof of concept.
2. **Slither second**, as a corroborating static source on the same snapshots.
3. **Aderyn third.**
Approval needed: installing any of them, the sandbox design, and the pinned-compiler supply route. None of this has been done.
