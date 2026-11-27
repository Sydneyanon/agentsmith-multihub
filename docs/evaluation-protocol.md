# Evaluation protocol: does P1–P3 structural intelligence improve security research? (2026-11-26)

**Status: protocol and results from existing evidence. Section 5 (corpus 5, a held-out evaluation on real repositories) is a design that
needs approval (A22, A23) before anything is acquired or scored.** Every number here is taken from a committed record or from an offline
re-run that this document names. No score is estimated.

## 1. Question and the claim we are allowed to make
The question: does each structural stage (P1 protocol model, P2 state-variable roles, P3 authority and trust boundaries) **find more real
vulnerabilities, or fewer false ones, on code it was not developed on**, compared with the stage before it and with the existing
baselines?

A claim of improvement needs **all** of the following:
1. a measurement on data that was sealed before the candidate was frozen;
2. a candidate registered (commit + tree) before scoring;
3. one scoring run;
4. every new lead outside the ground truth adjudicated by someone other than the analyzer's author.

Gains on development data (anything inspected before or during the change) show only that the change does what it was designed to do.

## 2. Evidence categories (used in every result table)
| Category | Meaning | Who decides |
|---|---|---|
| **Fixture** | A hand-written test contract built to exercise one behaviour | the developer; proves behaviour, never capability |
| **Known finding (label)** | A function a corpus author labelled vulnerable or safe before scoring | corpus author (synthetic ground truth) |
| **New lead** | A finding not covered by any label or known report | the analyzer; a hypothesis until reviewed |
| **Independently reproduced** | Exploit or behaviour reproduced by execution (offline EVM) or by a second, independent analysis, on unchanged code | reproducible script plus record; not a human verdict |
| **Human-adjudicated confirmed** | A named human reviewer, not the analyzer's author, signed an adjudication record that it is exploitable in its context | the human reviewer (`eval/adjudications/`, sign-off field) |
| **False positive** | Reported, and the label or adjudication says it is not a vulnerability | label or adjudication |
| **Refuted** | A hypothesis the validator or challenge rejected, with the reason recorded | validator or challenge; may itself be wrong (V1, V2) |
| **Inconclusive** | Neither confirmed nor refuted; the reason is recorded | anyone |

**Count to date of human-adjudicated confirmed findings: 0.** Every adjudication record still says "human sign-off: pending". No new
lead on real code has been independently confirmed.

## 3. Stage comparison on the frozen corpora (existing records)
TP / FP / FN on labels. "dev" = development data (inspected; not a measurement). **Bold** = a sealed, scored-once held-out measurement.

| Stage (commit) | dev | corpus 1 | corpus 2 | corpus 3 | corpus 4 |
|---|---|---|---|---|---|
| Baseline prototype (line patterns) | 10/4/7 | **8/10/10** | **13/16/24** | **8/7/23** | **12/6/26** |
| Candidate 1 (`6cd3be7`) | — | 18/1/0 (run 1) | **27/10/10** | **18/2/13** | — |
| Candidate 2 (`9c2d80e`) | 17/0/0 | 18/0/0 (dev) | 31/8/6 (dev) | **18/2/13** | **21/2/17** |
| Candidate 3, **pre-P1 frozen baseline** (`48d9a38`) | 17/0/0 | 18/0/0 (dev) | 31/8/6 (dev) | 18/1/13 (dev) | **20/1/18** |
| P1 | 17/0/0 | 18/0/0 | 31/8/6 | 18/1/13 | identical to candidate 3, label by label |
| P1+P2 (`7aad0d7`) | 17/0/0 | 18/0/0 | 31/8/6 | 18/1/13 | identical to candidate 3 |
| P1+P2+P3 (`09662af`) | 17/0/0 | 18/0/0 | 31/8/6 | **20/1/11 (dev)** | identical to candidate 3 |
| P3 closeout (this change) | 17/0/0 | 18/0/0 | 31/8/6 | 20/1/11 (dev) | identical to candidate 3 |

Sources: `eval/results/README.md`; `docs/analyzer-failure-classes.md`; the P1/P2/P3 evidence records; this closeout's re-runs (per-label
JSON compared with the previous stage). For corpus 4, only per-label **identity** with the frozen candidate-3 record
(`eval/results/heldout4-run1-candidate3-structural.json`) was checked. No label was read and nothing was tuned or re-scored.

### What these numbers support
- **On the only sealed measurement available since P1 (corpus 4), P1–P3 change nothing.** Every label is detected or missed exactly as by
  the pre-P1 candidate 3. P1 and P2 were designed to be behaviour-preserving, so this is expected. For P3 it means that its one
  detection gain (failure class C, cross-contract authority) did not occur in corpus 4, or that corpus 4's misses lie in other classes.
  We cannot tell which without reading corpus-4 labels, and we will not read them.
- **P3's gain is +2 TP, −2 FN, 0 new FP on corpus 3.** Corpus 3 is development data: class C was identified from these very files, so
  this is evidence of the fix, not of generalisation. Both cases are reproduced by execution (section 4).
- **P2's gain is one validator correction on a development fixture.** An aggregate maintained in a helper is now seeded consistently, so a
  real drain is validated instead of falsely refuted. It moved no corpus score.
- **Precision, measured where it is honest.** Candidate 3 has 1 FP on corpus 4 (all labels). On corpus 4's clear labels: 20 TP, 0 FP, 9 FN
  (recall 0.69). P1–P3 do not change that.
- **Not supported:** any statement that P1–P3 "improve security research" on unseen code. That needs corpus 5 (section 5).

### Missed classes (recorded, development data; corpus-4 classes not inspected)
On corpus 3 after P3, the remaining FNs are in the classes listed in `docs/analyzer-failure-classes.md`: B (inline-assembly storage
slots), D (a proxy exposing its implementation's surface), E (storage collision), F (unlocked implementations; labels marked ambiguous),
G (a value check taken for a one-time guard; corpus 2) and H (name-gated initialiser detection; corpus 2). There are also reentrancy and
unchecked-call misses, which the per-class corpus-3 table records.

## 4. Real-code evidence to date (development, not held-out)
| Source | What exists | Category |
|---|---|---|
| `crytic/not-so-smart-contracts` @ `020dbdb` | Two independent clone acquisitions per stage. Identical model and lead set each time (P3 closeout: model `99b9cb66…`, 34 leads, 29 open authority writes) | reproducibility only; the leads are **new leads**, none adjudicated |
| corpus-3 cross-contract labels | `eval/adjudications/heldout3-crosscontract-ground-truth.json` (EVM; safe twins as negative controls) | **independently reproduced** (execution); no human sign-off |
| corpus-3 reentrancy labels | `eval/adjudications/heldout3-reentrancy*.json` (EVM plus an independent assessor) | independently reproduced; human sign-off pending |

**Time and cost.** Analysis of the 25-file, 4.1 k-line real repository takes about 0.6 s wall time (two runs; 4-vCPU sandbox;
analysis only, excluding acquisition and database writes). Paid model spend: **$0** (no model is used). Corpus re-runs take seconds
each.

## 5. Held-out repository evaluation design (corpus 5), for approval
**Goal.** Measure recall, precision and new-lead quality on **real** repositories the analyzer has never been run on, against ground
truth that no one on the analyzer side chose or saw.

**Selection (independent, rule-based, fixed before acquisition).**
- A selector who is not the analyzer's author (a separate agent with no repository access, or the owner) picks 20–30 public Solidity
  repositories, each with **published** audit or contest findings and a public fix. Candidate sources: Code4rena and Sherlock report
  repositories, which are public and read-only.
- Inclusion rules, written down before selection:
  - findings of High or Medium severity in classes the engine claims (reentrancy, access control, initialiser, delegatecall/proxy,
    selfdestruct, unchecked call, tx.origin);
  - at least 10 repositories with findings **outside** those classes, to measure what is missed;
  - compilable Solidity ≥ 0.6;
  - at most 15 k lines in scope.
- **Controls.** At least a third of the entries are **post-fix** commits of the same repositories, or audited repositories with no High or
  Medium findings, for false-positive measurement.
- The selector records **why** each repository was chosen. Ruled out: any repository the analyzer has seen (`not-so-smart-contracts`) and
  any corpus 1–4 source.

**Pinning.** Each entry is recorded as repository URL, **commit SHA**, tree SHA, in-scope paths from the report, and a manifest SHA-256 of
the acquired files. Acquisition goes through the existing read-only 5.2 path (`GitHubSource`, public endpoints only). The corpus is
sealed (manifest committed) **before** a candidate is registered.

**Ground truth.**
- Each published finding is mapped to (file, contract, function, class) by the selector, with the report URL and the fix-commit diff as
  evidence.
- Findings the selector cannot map are kept as "unmappable", not dropped.
- The analyzer side never sees the mapping before scoring.

**Blinding and scoring.**
- The candidate is registered in `eval/candidates.json` (commit + tree) before the corpus is opened, and scored once.
- Results are stored as-is.
- No tuning on corpus 5, ever. It becomes development data after scoring, exactly like corpus 4.

**Independent review of new leads.**
- Every lead not matching a ground-truth entry goes to a reviewer who is not the analyzer's author. The reviewer sees the code and the
  claim, not the analyzer's confidence or class score.
- The reviewer classifies each lead as confirmed, false positive or inconclusive, with reasons.
- Where possible, execution evidence is produced offline (in-memory EVM, no network, no live chain).
- A "confirmed" lead counts as a **human-adjudicated confirmed finding** only with a named reviewer's sign-off.
- **No disclosure or bounty submission without separate owner approval.**

**Metrics (computed only from the stored run).**
| Metric | Definition |
|---|---|
| Recall (per class, overall) | mapped ground-truth findings detected at the right function ÷ mapped findings; reported for claimed classes and for all classes |
| Precision | TP ÷ (TP + FP), where FP = leads on control commits plus leads the reviewer rejects |
| FP rate per kLOC | false positives ÷ in-scope kLOC |
| New findings per stage | leads beyond ground truth, by review outcome (confirmed / FP / inconclusive), per stage (pre-P1 candidate 3, P3 candidate) |
| Missed classes | ground-truth findings missed, by class, including classes the engine does not claim |
| Coverage | share of in-scope files parsed, entry points analysed, and model `unknowns` per repository |
| Reproducibility | two independent acquisitions give identical model hash and lead set |
| Time / cost | wall time per repository (acquisition, analysis); paid spend (expected $0) |

**Stage comparison on corpus 5.** Score candidate 3 (pre-P1) and the P3 closeout candidate (and the baseline prototype) once each, in
clean worktrees, in a fixed order. The difference is the P1–P3 effect on real code.

**Size and power.** About 20–30 repositories and an expected 60–120 mapped findings. That is enough to see a per-class difference of
several findings. It is not enough for fine per-class rates; the report says so.

## 6. Staged plan
1. **E0 (done here):** consistency closeout, regression on corpora 1–3, aggregate identity on corpus 4, EVM reproduction of the corpus-3
   gains.
2. **E1 (T-180):** write the corpus-5 selection brief and inclusion rules; owner review. Documentation only.
3. **E2 (T-181, needs A22):** independent selection and ground-truth mapping by the selector; read-only public acquisition; seal.
4. **E3 (T-182, needs A23):** register candidates; score once each; store raw results.
5. **E4 (T-183):** independent review of new leads; adjudication records; human sign-off by the owner or a named reviewer.
6. **E5 (T-184):** report: recall, precision, new findings per stage, missed classes, coverage, reproducibility, time, cost.

## 8. Benchmark integrity (T-205, 2026-11-27)
**Why:** in T-203 a blind specialist disagreed with two dev labels marked safe. Executed tests showed both functions are ownership
takeovers. A tool tuned to those labels scores perfectly against them and still misses both. Agreeing with an answer key is not the
same as finding vulnerabilities, so the measurement itself needs rules.

**Rules (enforced by `eval/integrity/`, tested in `eval/integrity/integrity.test.ts`):**
1. **Original labels are immutable.** Every labels file and answer key is pinned in `eval/LABELS.sha256`; frozen corpora keep their
   `MANIFEST.sha256`. Both are checked by `eval/verify-frozen.sh` and by the test suite. A changed label fails the suite: it can only
   change through a visible manifest update and a note in the results.
2. **Disputed labels are adjudicated separately** (`eval/adjudications/`). A record must quote the original label exactly, name the
   disputing source and carry evidence; otherwise it is invalid and nothing is scored.
3. **Independent human sign-off is mandatory.** Only a record signed by a named human independent of the disputant changes the
   adjudicated reading. Who adjudicates is A41.
4. **Results are reported against the original and the adjudicated labels separately.** A third, provisional reading (pending
   records applied as if signed) is shown and marked "not adopted".
5. **Exposure is declared** (`eval/exposure.json`): for every capability and corpus, whether it was **tuned**, **blind**,
   **blind-labels**, **seen** or **same-family-authored**, plus whether the corpus could be in a model's training data. No declaration
   means no score.
6. **No disputed label silently changes a score.** The original reading never moves; the report names the labels hash and the records
   it applied.

**First report:** `eval/results/dev-dual-reading.md` (generated; `npx tsx eval/integrity/score-dual.ts --check` verifies it is
current). The structural analyzer's 17/0/0/14 on dev is labelled **tuned**. Under the provisional reading it would miss 2.
