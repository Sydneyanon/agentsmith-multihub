# ML readiness assessment (2026-11-26)

**Conclusion: no ML model can be trained honestly today.** The data that ML-1 and ML-2 would learn from does not exist yet:
- research decisions with outcomes;
- adjudicated discoveries on real code;
- coverage history.

The first experiment is therefore **data and baseline**, not a model. No training, shadow deployment or live use is approved.

## 1. Data that exists
| Data | Size | Provenance | Usable for ML? |
|---|---|---|---|
| dev corpus labels | 31 labels, 17 vulnerable | hand-written fixtures, inspected throughout development | No for evaluation; at most a feature smoke test |
| Corpus 1 labels | 47 labels, 18 vulnerable | separate author; scored, then used for development | development only |
| Corpus 2 labels | 96 labels, 37 vulnerable | separate author; scored once, then tuned on | development only |
| Corpus 3 labels | 79 labels, 31 vulnerable | separate author; scored, then failure-class work done on it | development only |
| Corpus 4 | sealed and spent; labels not opened | separate author | **never**: no inspection, tuning, rescoring or model decisions |
| Corpus adjudications | 2 reentrancy (EVM + independent assessor, sign-off pending); 2 cross-contract reproductions (EVM, no sign-off) | `eval/adjudications/` | labels for validator evaluation, not discovery labels |
| Real-repository leads | 34 leads on `not-so-smart-contracts` @ `020dbdb` (educational code with known answers) | analyzer output | unadjudicated; not labels |
| Research decisions, costs, outcomes | **none** | no worker has run in production | n/a |
| Human-confirmed discoveries | **0** | — | n/a |

All corpus labels are **synthetic, single-function and per-class balanced by design**, and written by AI authors from class briefs. They
measure detection of known shapes. They say nothing about which real repositories, components or paths yield discoveries, which is
what ML-1 and ML-2 are for.

## 2. Missing labels
- **ML-1 (priority).** Per-candidate outcomes at each decision level: was the opportunity, repository, component or path
  investigated, at what cost, and with what adjudicated result (including "nothing found" with coverage). This needs decision records
  and coverage records (architecture §3B, §3D; migrations unapproved) and real runs (A26).
- **ML-2 (signal).** Function or path-level labels on **real** code: adjudicated vulnerable, adjudicated safe, unknown. The only
  credible near-term source is corpus 5 (published audit findings mapped to functions, plus post-fix controls) and, later, the
  engine's own adjudicated outcomes.
- **ML-3 (strategy).** Method × context × outcome records. These need ML-1-level data across several specialists. Not before level 4.

## 3. Leakage and bias risks
| Risk | Where | Control |
|---|---|---|
| Fixture-shape leakage | corpora 1–4 are per-class twins (`pair` field) from similar generators; a model learns the generator's style | never evaluate on corpus data; train on it only for smoke tests |
| Development reuse | corpora 1–3 were inspected and tuned on | treat as development; report any use |
| Code-family leakage | forks and copies (OpenZeppelin bases, protocol forks) appear in many repositories | split by **code family** (hash of normalised component content; shared-base clustering), not by file or repository |
| Temporal leakage | features computed after the fact (a fix commit, a public report) | compute features only from the snapshot commit and data dated before it |
| Selection bias | audited and exploited repositories are not a random sample; contest repos over-represent certain classes | stratify; report per class; include post-fix and clean controls |
| Label bias | only investigated candidates get outcomes (the policy chooses what is labelled) | exploration share in policy v0; inverse-propensity weighting in evaluation; log non-actions |
| Corpus 4 | spent benchmark | excluded from every ML step, permanently |

## 4. Baselines every model must beat
1. **Null.** Random order, and claim order (today's queue).
2. **Deterministic policy v0** (architecture §3B), with fixed weights recorded before evaluation.
3. **Structural analyzer alone**, for ML-2: ranking functions by existing lead presence and confidence.

## 5. Recommended first experiment (ML-0): no model training
1. Specify the decision, coverage and outcome record schema, as a design (part of T-149 S2/S4).
2. Specify deterministic policy v0 and its function-level ranking. Run it **offline** on corpus 5 once corpus 5 exists, against null
   baselines. Metric: recall of mapped findings within the top-k functions per repository, and analyst time saved. That is v0's
   baseline score.
3. Only then design ML-1 (a LightGBM ranker over the shared model's features) with:
   - a code-family split;
   - a pre-registered metric (confirmed, differentiated discoveries per hour and per dollar; top-k recall as a secondary);
   - a minimum data threshold before training. Suggested: at least 200 adjudicated real-code outcomes, with positives from at least
     30 independent code families. Fewer than that cannot support a tree ranker's variance.
4. Shadow mode: ML-1 ranks beside v0 and the Control Room shows both, but only v0 acts. ML-1 is promoted only if it beats v0 on unseen
   repositories on the pre-registered metric, with owner approval.

Graph neural networks, custom foundation models and ensembles stay out of scope unless a simple model's measured shortfall
specifically motivates them.
