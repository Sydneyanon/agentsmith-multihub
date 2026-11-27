# Specialist researchers in AgentSmith: inventory, evidence and integration (T-203, 2026-11-27)

> **Round 2 (verified from `811376f`; full verify re-run: 883 unit passed and 1 skipped, 294 + 294 integration, exit 0).** Five
> more blind experiments; section 6 has the results. Headline: on the labelled dev corpus, a generalist hunter matched the structural
> analyzer's recall and found **two label errors**, both confirmed by executed tests. That means P1–P3, which was tuned to those labels,
> misses two real ownership takeovers. A reproduction specialist demonstrated measured impact for 4 of 4 seeded issues. A prior-art
> specialist found 10 of 10 duplicates with 1 false duplicate. On real code, the challenger caught a fabricated citation and corrected
> severities.

**Status:** integration implemented on the branch and tested on throwaway databases. The research test was run in this attended Claude
Code session against a synthetic fixture and, blind, against one real public codebase whose results are kept only in the private case
repository. Nothing is deployed, no draft is applied, no worker runs any of this, and no model is called by AgentSmith itself.

## 1. Inventory: what this environment actually has (checked 2026-11-27)

| Capability | What it is | Research use | Runtime |
|---|---|---|---|
| `general-purpose` sub-agent | full-tool agent (read, search, shell) | **yes**: the specialists below are this agent with a research method | attended session only |
| `Explore` sub-agent | read-only search agent | locating code only; it does not audit | attended session only |
| `Plan` sub-agent | design/planning agent | not used for research | attended session only |
| `claude-code-guide`, `statusline-setup`, `web-fetch` | product help, config, page fetch | none (web fetch is forbidden for research here) | attended |
| Skills: `/security-review`, `/code-review` | review of the current diff/branch | reviews **our** changes, not a target repository | attended |
| Workflow tool | multi-agent orchestration | **not used**: needs your explicit opt-in, and T-149 stays the only orchestrator | attended |
| MCP servers: GitHub, memory, Claude Docs, remote sessions, a payments wallet | integrations | none for research; the wallet is never used | attended |
| Hooks | a Stop hook asking to commit and push | none | attended |
| Terminal tools | Python, Go, Cargo, Node, Docker binary; Slither 0.11.3 and Foundry 1.5.1/solc 0.8.28 **in session-only locations** | Slither is integrated (T-201); Foundry ran the challenger's tests (below) | session only until A39 |

There is no built-in "security specialist" agent. A specialist is a `general-purpose` sub-agent given one research **method**. The
method prompt is versioned and hash-pinned in `apps/api/src/engine/capabilities.ts`.

## 2. What the specialists actually did

### 2.1 Synthetic probe (`eval/dev/specialist-probe/`)
- **Fixture:** 6 small contracts (vault, staking rewards, lending pool with an AMM price, AMM pair, payout splitter).
- **Seeded issues:** 6, chosen in classes Slither and P1–P3 do not model, plus 4 decoys.
- **Answer key:** written before any run; SHA-256 `fe7d094d617743b3773d9dbd0ddec950a75cdedca3202e7ed55cd71921d1d3a4`.
- **Blinding:** each specialist ran blind, on the fixture only, with no network, and unaware of the others.

| Seeded | Slither 0.11.3 | P1–P3 structural | scoping | accounting | path (v2) | assumptions | liveness |
|---|---|---|---|---|---|---|---|
| S1 share inflation | – | – | ✔ | ✔ | ✔ | ✔ | – |
| S2 withdraw rounds the wrong way | – | – | ✔ | ✔ | ✔ | ✔ | consequence only |
| S3 stake skips the user checkpoint | – | – | ✔ | ✔ | ✔ | ✔ | (out of class) |
| S4 spot-price oracle | – | – | ✔ | ✔ | ✔ | ✔ | (out of class) |
| S5 unprotected `setPair` | – | **✔** | ✔ | ✔ | ✔ | ✔ | ✔ |
| S6 push-payment lock | weak (`calls-loop`, low) | – | ✔ | **examined and cleared: a miss** | notes only | ✔ | ✔ |

**Baselines:**
- **Slither:** 0 of 6 mechanisms (30 detector results, mostly noise).
- **P1–P3 structural:** 1 of 6.
- **Specialists:** 5 or 6 of 6 each, with about 80k sub-agent tokens and 1.5–2.3 minutes per run (`outputs/effort.jsonl`).

**Decoys:**
- None were reported as a reentrancy issue without the condition (callback tokens) that makes it real.
- One specialist overstated the view-only list (D3) as a high-severity liveness issue.

**Unseeded but plausible findings:** several specialists independently raised the same extra issues:
- no liquidation path;
- an owner-set rate that overflows and locks withdrawals;
- swap input that can be taken between two transactions;
- fee-on-transfer assumptions.

**Independent challenger:**
- **Input:** given 16 claims, de-duplicated and stripped of producer identity.
- **Verdicts:** upheld 15, several with corrections, and **rejected 1**: C08, the "division by zero after drain" claim, with a test showing the vault's own functions cannot empty assets.
- **Corrections:** it narrowed C01's impact (the drain shrinks and stops) and C16 (temporary, not permanent).
- **Tests:** it wrote 7 local Foundry tests. **I re-ran them independently: 7 passed** on an unmodified copy of the fixture
  (`challenger-tests/Challenge.t.sol`).

**Safety classifier:** the first path-tracer run was **stopped by the session's safety classifier** while writing step-by-step attack
sequences, and produced nothing. The re-scoped method (dependencies, mechanisms and the test that would settle each) completed. All
attended methods now ask for audit-report form, never exploit steps (`capabilities.ts`).

### 2.2 Blind test on real code (private case; details only in the private repository, record 14)
- **Setup:** one accounting specialist, given only the pinned source tree (no history, no notes), with no network and nothing run.
- **Result:** it **independently identified the case's verified failure mechanism**, the one the deterministic analyzer missed in
  record 09, with the right lines and reset condition. It did not overclaim permanence.
- **New hypotheses:** it raised two, both unverified.
- **Effort:** 168k tokens, 7.9 minutes.
- **Caveats:**
  - It is a rediscovery of a mechanism AgentSmith had already reproduced, not a novel discovery.
  - The model may have seen this public code in training.
  - It is one run.

### 2.3 What this does and does not show
- **Shown:** attended specialists cover classes the existing machines do not (accounting, precision, oracle, liveness), on a synthetic
  fixture and once on real code. A challenger can refute an overstated claim and author executable tests. The integration keeps every
  model output in the claim plane.
- **Not shown:**
  - **Novel discovery.** The fixture is textbook and was written by the same model family; that is contamination and easiness bias.
  - **Calibrated precision or recall.** The sample is tiny.
  - **Real complementarity between specialists.** On textbook bugs, specialisation barely mattered: most specialists found most
    issues, and the narrow ones missed out-of-class issues by design.
  - **Independence between Claude specialists.** They are the same underlying model, so their agreement is not independent
    corroboration.
- **The proper measurement** is the pre-registered corpus-5 evaluation (T-180/T-182) with attended specialists as arms (T-204).

## 3. Integration (implemented; T-149 is still the only orchestrator)

| Capability (`capabilities.ts`) | Kind | Step of the one workflow | Classes | Runtime | Cost units |
|---|---|---|---|---|---|
| solidity-structural-specialists@1 | producer | `investigate_target` | 7 structural | in-process, unattended | 1 |
| slither@0.11.3 | producer | `slither_scan` | 12 detector classes | local tool, unattended (needs A39 to persist) | 2 |
| agentsmith-execution-validators@1 | evaluator (plane 2) | `challenge_target` | 6 | in-process | 1 |
| foundry-forge@1.5.1 | evaluator, **prepared** | `foundry_validate` (T-202) | any, via a test | local tool | 3 |
| claude-scoping@1 | **mapper** | `specialist_review` | architecture-map | attended only | 10 |
| claude-accounting@1 | producer | `specialist_review` | accounting-invariant, arithmetic-precision, economic-incentive | attended only | 10 |
| claude-path@2 (APEX precursor) | producer | `specialist_review` | multi-step-path, oracle-manipulation | attended only | 10 |
| claude-assumptions@1 (Weirdness precursor) | producer | `specialist_review` | assumption-violation, liveness, economic-incentive | attended only | 10 |
| claude-liveness@1 | producer | `specialist_review` | liveness | attended only | 10 |
| claude-challenger@1 | **reviewer** | `specialist_challenge` | (challenge) | attended only | 10 |

Each declaration records:
- identity and version (attended versions pin the method prompt hash, `1+prompt-<12 hex>`);
- specialisation, required inputs and expected outputs;
- the role (producer, evaluator, reviewer or mapper);
- limitations and failure modes (including the classifier stop);
- runtime, availability mode, cost units and a cost note;
- relevance signals.

**How AgentSmith chooses** (`mapAndAssign`, recorded in every decision as `capability_values`):
- **Mapper first:** a mapper goes first on an unmapped snapshot. Its ranked attack surface then becomes a named, sourced contribution
  to component priority (`specialist-surface`, component-priority/3).
- **Value rule:** for the chosen component, value = pending classes × relevance ÷ cost units. Relevance comes from protocol-model facts:
  P2 ledger and aggregate variables for accounting, outward calls for path and assumptions, lists for liveness.
- **Complementary machines:** a class one machine examined is still pending for another.
- **In-flight work:** work already assigned and not finished is never assigned again.
- **Skipped classes:** a class a specialist says it did not examine is recorded as `abstained` and not re-assigned at that version.
- **Availability:** attended capabilities are available only when the CLI runs with `AGENTSMITH_ATTENDED_OPERATOR` set. Workers never
  claim `specialist_review` or `specialist_challenge`.

**How results enter** (`engine/attended.ts`, CLI `brief`, `export-snapshot`, `import-specialist`, `import-challenge`):
- **Brief:** `brief` shows exactly what the specialist gets.
- **Export:** `export-snapshot` writes the hash-checked sealed files (a filesystem effect: dry run by default).
- **Import checks:** schema validation; each finding is anchored to real lines of the sealed snapshot (unanchored or out-of-target
  findings are rejected and counted, never stored); one import per step.
- **Recording:** claims are stored as plane 1 under the new provenance kind `attended_model` (A29 draft). That kind is not a paid
  `model` call and not a human.
- **Effort:** operator-reported tokens and duration are recorded as effort.

**Independent challenge** (`follow_up` decisions):
- **Automatic assignment:** every attended claim without a review gets a blinded challenge assignment. The challenger sees the claim
  text and evidence locations only, never the producer's identity or rationale (enforced by 0007's blinded-review check).
- **Verdicts are reviews:** they are stored in the claim's own run, never as evidence.
- **Database guards** (A29 draft):
  - a specialist can never review its own claim;
  - models can never write evaluations;
  - "confirmed" still needs technical evidence from an evaluator other than the producer, and a human adjudication (T-144). So
    **no specialist, and no pair of specialists, can confirm anything**.
- **Human review:** claims supported by the challenger, or by technical evidence, are sent for human review; only a human records
  confirmed, refuted, inconclusive, duplicate or missed.

**Comparison and memory** (`compare --snapshot`, `engine/compare.ts`):
- **Per capability:** components and classes examined, leads, and unique finds.
- **Per lead (contract, function, class):** who found it, who examined it and did not find it (a candidate miss), technical supports,
  model review verdicts, and the human outcome.
- **Source:** all from durable records; effort is in `research_effort` and step outputs.

## 4. APEX, Weirdness and the priority engine: the same engine
- **APEX:** `claude-path` is the attended precursor of APEX path exploration. Its dependency maps and violable-assumption claims use
  the existing `path`/`multi-step-path` classes. An unattended APEX would be a producer with the same step contract.
- **Assumption breaking and counterexample generation:** `claude-assumptions` (Weirdness precursor) produces assumptions,
  counterexamples and oddities. Its oddities are the natural input to the Weirdness signal in component priority.
- **Temporal sequences:** covered by the path and accounting methods (cumulative effects), as claims; settling them needs executed
  tests (T-202).
- **Priority engine:**
  - the scoping map steers target order;
  - the capability values steer who is assigned;
  - coverage and abstentions per capability, and candidate misses, are the data T-192 and ML-1 learn from.
- **Independent challenge:** `claude-challenger` is a reviewer. The technical evaluators (validators now, Foundry under T-202) remain
  the only plane-2 evidence. The challenger's executable tests show a path into T-202: a test written by the challenger, run by a
  pinned `foundry-forge` evaluator, would be technical evidence by a party other than the producer.

## 5. Runtime: what runs where, and what it costs

| | Today | Requires |
|---|---|---|
| Interactive, now | everything in section 2: sub-agents in this attended session (your subscription; about 80k tokens per specialist run) | nothing more |
| AgentSmith, locally, unattended | structural specialists, validators, the loop, the CLI; Slither and Foundry where installed | A39 to install the tools persistently |
| AgentSmith with attended specialists | the engine decides, briefs and imports; a named operator runs each sub-agent | an operator present; never on a worker |
| Unattended model specialists | **not built** | A31 (paid API under the US$25/month gateway), then an unattended runtime that calls the gateway per assignment. A specialist run here cost about 80–170k tokens, so the cap allows only a small number of runs per month |

A Claude Code subscription is not assumed to give unattended runtime access. Nothing in this change calls a model.

## 6. Round 2 experiments (2026-11-27)

| Experiment | Setup (keys fixed before the runs) | Result | Checked by |
|---|---|---|---|
| **E1: generalist hunter on the labelled dev corpus** (31 labels: 17 vulnerable, 14 safe; `eval/dev`) | blind; a verdict for every external function | 17/17 vulnerable found; all 5 exploitability notes correct; 3 calls against "safe" labels; 1 extra (`Misc.setImpl`, unlabelled, a real unguarded setter) | per-function scoring script, then the code and executed tests |
| baseline: P1–P3 structural | same labels | 17/17, 0 against labels (developed against this corpus) | `analyzeSources` |
| baseline: Slither 0.11.3 | same labels, detector-to-class map | 10/17, 2 false positives | recorded real output |
| **Label check** on the hunter's 3 disagreements | local Foundry (session-only), unchanged contracts | **2 label errors**: `Config.transferOwner` (write-then-check lets any caller take ownership) and `Misc.initOnce` (first caller replaces the constructor-set owner); both shown by passing tests. **1 false positive**: `Misc.eoaGate` (harmless griefing) | `eval/adjudications/dev-access-control.json` (labels NOT edited; overturn proposed, human sign-off pending) |
| **E2: reproduction** of 4 seeded probe issues | criteria: tests must assert impact, not a revert | 4/4 demonstrated with measured impact: 500e18 bad debt and 490e18 profit; pool drained to 0; 1000e18 locked after retry; double-counted rewards. Plus a healthy-token control | **I re-ran the 5 tests: all pass**; fixture copy byte-identical; assertions are balance-based (`specialist-probe/reproduction-tests/`) |
| **E3: prior-art / duplicates**, 16 claims vs a local 12-entry disclosure corpus | key `outputs/round2/prior-art-key.json` | duplicates 10/10 with the right disclosure each time; 1 false duplicate (C13); 5/6 non-duplicates kept; its own summary miscounted (10 vs 11) | scoring script |
| **E4: challenger on the 3 real-code claims** (private case; details private) | blinded | upheld all 3 with corrections: the known mechanism's reset paths and timescale, matching the verified case records; lowered the severity of the other two; **caught a citation of non-existent lines** | private record 15 |
| **E5: cross-contract path specialist on real code** (private) | blind | 8 unverified claims, all 23 citations real. One claim was found **independently** of the accounting specialist (two methods, same issue). It **did not** find the known mechanism, though liveness was in its classes: a candidate miss, and the reason AgentSmith assigns complementary methods | private record 15 (186k tokens, 7 minutes) |

**What round 2 adds to the evidence**
- **The strongest result:** E1's two label errors. A specialist found real, executable ownership-takeover bugs that the labelled
  ground truth, and so the structural analyzer tuned to it, treated as safe. It is still a small development corpus written for
  testing, and the adjudicator (this session) shares the specialist's model family. The overturn therefore needs your sign-off, and
  scores stay on the original labels until then.
- **Reproduction works on synthetic code:** the tests demonstrate impact, not reverts. They are executable evidence only once a pinned
  evaluator runs them (T-202). Until then they are claims with attached tests.
- **Fabricated citations are a real failure mode,** seen on real code. Import already refuses unanchorable locations; it now also counts
  rejected locations on stored claims as a credibility signal.
- **Prior-art triage is accurate on a local corpus.** It needs registered prior-art records to be useful (T-144 `external_references`);
  external sources need A40.

**Integration added in round 2**
- `claude-hunter@1`: an active producer for the structural classes, complementary to P1–P3 by semantics rather than patterns.
- `claude-reproducer@1` and `claude-prior-art@1` are declared **prepared** (not assignable): the reproducer needs T-202 and A39; prior
  art needs registered sources (and A40 for external ones).
- **Track records:** every decision now records each capability's track record from durable memory (claims, independent technical
  supports, challenger verdicts, human outcomes). The record is **not used in selection** until a capability has at least 5
  human-adjudicated outcomes and a policy version that uses it is recorded and evaluated (T-192/T-193). Lead volume earns nothing.
- **Rejected locations:** imports keep a count of rejected locations per stored claim.
