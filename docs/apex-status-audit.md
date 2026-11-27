# APEX and research-tool status audit (2026-11-27)

**Method:** `command -v` and version calls in this container, the code in the repository, the release image's contents, and the
recorded results in `eval/results` and `docs/`. "Integrated" means it has an invocation path from the research pipeline, input and
output contracts, tests, and evidence of execution. Being installed or listed in configuration does not count.

## Verdict
- **APEX is not implemented.** It is a roadmap commitment (`docs/apex.md`: "not designed in detail, not authorised for
  implementation, not started") with two prior-art passes.
- What exists is substrate that APEX would build on:
  - inlined effect traces;
  - an execution interpreter;
  - the protocol model;
  - bounded two-call re-entry search;
  - execution validators.
- **The first production run uses the deterministic structural analyzer and its execution validators only.** It is not evidence
  that APEX or any external tool works.

## Tool by tool

| tool | installed? | configured? | callable from AgentSmith? | in the production research pipeline? | run on a real repository? | useful findings? | evidence |
|---|---|---|---|---|---|---|---|
| **Slither 0.11.3** | **No**: not in this container, not in the image | yes: capability `slither`, requires `AGENTSMITH_SLITHER_BIN` and `AGENTSMITH_SOLC_BIN` | yes, via the engine loop's `slither_scan` step (`engine/tools/slither.ts`: pinned version, fixed arguments, timeout, private working directory, explicit failure codes) | **No.** The engine loop needs draft migrations 0008–0010, which are not applied, and the binary is not in the image. | Not on a bounty repository. It ran once on the frozen dev corpus in an earlier, discarded container. | On dev: 10 TP, 2 FP, 7 FN, 12 TN (blind labels). Its misses include 4 access-control functions and 1 initializer | `eval/results/dev-dual-reading.md`; `docs/specialist-capabilities.md` §4; CI replays recorded output |
| **Foundry 1.5.1** (forge/anvil) | **No**: earlier scratchpad installs are lost; not in the image | `foundry-forge` capability declared (`AGENTSMITH_FORGE_BIN`) | `runForgeTest` exists (`engine/tools/foundry.ts`: offline, pinned, per-test results with hashes) | **No.** Declared `prepared`, never assigned; it needs a test author. | Yes, but attended only: an earlier private case study ran Foundry tests against a real protocol at a pinned commit, with me working by hand. That was not through the pipeline. | That case's outcome is in its case record. Not re-verified here. | `docs/specialist-capabilities.md` §1 and §4 |
| **Echidna** | No | No | No | No | No | — | inventory only |
| **Mythril** | No | No | No | No | No | — | inventory only |
| **Semgrep** | No | No | No | No | No | — | inventory only |
| **Claude Code, subagents, skills, `/security-review`** | only inside an attended session like this one | attended capabilities `claude-hunter`, `-path`, `-accounting`, `-assumptions`, `-liveness`, `-reproducer`, `-challenger`, gated by `AGENTSMITH_ATTENDED_OPERATOR` | via `engine/cli.ts` with a named operator; results enter as that human's input | **No.** Never unattended. | Attended work on real code earlier; stopped by the owner's instruction on third-party findings | On dev, `claude-hunter@1` blind: 17 TP, 2 FP, 0 FN, 12 TN. That is an attended run, so it says nothing about unattended operation. | `engine/capabilities.ts`; `eval/results/dev-dual-reading.md` |
| **MCP, hooks, Routines (scheduled tasks)** | none configured for AgentSmith (`.claude/` holds only temporary worktrees; no `.mcp.json`) | No | No | No | No | — | repository listing |
| **Claude Agent SDK / unattended model calls** | not a dependency | **No production model adapter. The reviewed price catalog is empty by design.** | the budget gateway exists ($25/month, tier caps), but has nothing to call | No | No | — | `ai-budget.ts`; `package.json` |
| **Weirdness Engine (5.5A)** | — | — | **No code.** It is named in documentation only. | No | No | — | `docs/apex.md`, capability text |
| **Priority Engine** | in the repository | yes (`apps/api/src/priority/`: scoring v1, coverage, replay) | yes, inside the engine loop's target selection | **No.** Same draft-migration dependency as the engine loop. Its own design doc says "not connected to real discovery or acquisition data". | No | On a synthetic replay it does **not** beat round-robin | `docs/adaptive-priority-engine-design.md` §11 |
| **Research and experience memory** | drafts only | `db/drafts/t144-research-memory` (0009) and `a29-engine-loop` (0010), never applied outside throwaway databases | in the engine loop | **No** | No | — | draft READMEs |
| **Hypothesis generation and validation** | yes | yes | yes | **Yes.** `analyze_structure` → `challenge_leads` → `build_dossier` | Locally, on a real bounty repository at a pinned commit; analysis initially failed on the citation bug, now fixed. **Not yet in production.** | Benchmarks: dev and heldout P=R=1; heldout2–4 P 0.80–0.95, R 0.53–0.84; benchmark-b recall 0 | `docs/vuln-detection-benchmark.md` |

## How close APEX is to exploring real protocols
- **Not close.** It has no design approved for implementation (T-150 and T-151 were never reviewed), no search engine, no
  multi-contract world model, and no sequence search beyond two-call re-entry.
- The prerequisites that exist:
  - the commit-pinned acquisition, sealing and dossier pipeline (about to run in production);
  - the trace and interpreter substrate;
  - the evidence and validation store.
- **Missing for "explore and reproduce":**
  1. An executable counterexample engine: Foundry in the pipeline. This is APEX capability 7.
  2. Persistent research memory: drafts 0009 and 0010.
  3. An unattended reasoning producer within the budget: a model adapter plus a reviewed price.
  4. The APEX design itself.

## Smallest practical next steps, in order of value per effort
Every step runs inside the **existing** `repository_research` workflow: findings become hypotheses in the same store, are
challenged by `challenge_leads`, and appear in the dossier with their generator named. None of this blocks the first run.

1. **Slither as a pipeline step: `slither_scan`, between `analyze_structure` and `challenge_leads`.**
   - **Why first:** it is the only external tool with measured value (dev: 10 TP, 2 FP), and the runner and its contracts already
     exist.
   - **Work:**
     - move the step out of the engine loop, so it needs no draft migration;
     - ship pinned `slither 0.11.3` and `solc 0.8.x` in a **separate worker tools image**, so the API image stays minimal;
     - set CPU, memory and time limits, with no network;
     - record failures as explicit abstentions, so `compile_failed` appears in coverage instead of being hidden.
   - **Tests:** the existing recorded-output tests, plus one run with the real binary inside the image's smoke test.
   - **Approvals:** a new image and installing the tools.
2. **Foundry as the counterexample evaluator: `foundry_validate`, the seed of APEX capability 7.**
   - **What:** for reentrancy and access-control leads, generate a template regression test from the lead, and run it offline,
     pinned, against the sealed snapshot. A pass becomes plane-2 evidence; a failure or abstention is recorded as such.
   - **Test author:** the template generator, not the producer, which keeps the independence rule.
   - **Approvals:** the tools image, and a template-generator review.
3. **Research memory (0009/0010) applied, after review.**
   - **What it enables:** learning from failed investigations: abstentions, refutations, missed findings. Coverage per
     (capability, class) is what lets the Priority Engine steer on real data.
   - **Approvals:** production migrations.
4. **APEX T-150 and T-151:** the prior-art and novelty assessment, and the architecture design, for review, before any APEX code is
   written. They follow the doc's own rule.
5. **Later, only with measured need:**
   - Echidna or Medusa, for invariant properties on the not-modelled classes;
   - an unattended model producer, through the gateway, which needs a model adapter and a reviewed price;
   - Mythril and Semgrep last: they overlap with what exists and are noisy.

Every step ends in the same measured outcomes: leads, validated leads, false positives, coverage and cost per run, scored on the
frozen corpora before production.
