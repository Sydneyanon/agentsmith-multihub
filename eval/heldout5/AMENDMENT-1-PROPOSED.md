# Corpus 5: proposed amendment 1 (2026-11-28). NOT in force until the owner approves it together with A22

Purpose: make corpus 5 the blind benchmark for the semantic capabilities planned next (invariants, accounting, state transitions,
APEX), and freeze the evaluation criteria **before** any selection or scoring. The approved `BRIEF.md` and `PROCESS.md` are unchanged.
If this amendment is approved, it is appended to the brief the selector receives.

## 1. Class mix (replaces the minimum counts in the brief's "Class mix")
| group | minimum entries | classes |
|---|---|---|
| structural | 8 | reentrancy, access-control, initializer, delegatecall/proxy, selfdestruct, unchecked-call, tx-origin |
| **semantic** | **12** | `accounting` (rounding, share/asset conversion, fee mis-accounting), `invariant` (conservation broken: supply vs balances, totals vs ledger), `state-transition` (an illegal phase or status change, missing a state check), `cross-contract` (trust or ordering across contracts), `economic` (oracle/price manipulation, liquidation, incentives), `sequence` (requires two or more transactions in a specific order) |
| controls | ⅓ of all entries | post-fix commits and clean reviews, as in the brief |

Each semantic finding must state, in the selector's own words, the **broken property** (one sentence). That sentence is kept in
`ground-truth.json` only, never in the repository.

## 2. Independence and custody (strengthened)
- **Selector:** a person, or a system with **no access** to this repository, its documentation or its results.
  - A Claude session counts only if it is started with no repository and no tools that can reach it.
  - Disclosed weakness: it is the same model family as the analyzer's developer. That is recorded on every result.
  - A human selector is preferred.
- **Custody of the answer key:** `ground-truth.json` is held **outside** the repository by the owner or the selector until scoring.
  - Only its SHA-256 is committed, at selection time.
  - At scoring it is supplied to the scorer, and its hash is checked against the committed one.
- **Class descriptions** for this corpus are never written into the repository before scoring. This is the lesson from
  benchmark-b, whose descriptions are published in `docs/vuln-detection-benchmark.md`.

## 3. Frozen evaluation criteria (preregistered, applied unchanged at scoring)
1. **Unit:** a (finding, location) pair. A lead **matches** a finding when it names the same contract and function, and its primary
   span is within ±5 lines of a location the selector listed, or inside the same function body. The class does not have to match;
   class agreement is reported separately.
2. **Metrics, reported per group (structural, semantic, controls) and overall, with 95% Wilson intervals:**
   - recall over findings;
   - precision over leads: a lead matching no finding is a false positive, and in controls every lead is one;
   - false positives per 1,000 lines of in-scope code;
   - abstention rate: leads marked inconclusive, and repositories marked partial or not analysable.
3. **Capabilities scored:** each registered candidate, scored **once**, in registered order, clean worktrees, harness unchanged:
   - the frozen structural analyzer (`structural-solidity/2`);
   - the Slither stage, if it can execute in the scoring environment, otherwise reported as abstained;
   - any semantic or APEX candidate registered before selection.
4. **Primary claim rule:** a capability "improves on" another only if its semantic-group recall is higher **and** the 95% intervals do
   not overlap **and** its control false-positive rate is not higher. Anything else is reported as "no demonstrated difference".
5. **Null results** are recorded and published like positive ones. No re-scoring after changes: once a corpus is scored, it is
   development data (`*-DEVELOPMENT-not-heldout*`).
6. **Ambiguous mappings** go to adjudication (`eval/adjudications/`). Labels are never edited.

## 4. Approvals this needs
| gate | what |
|---|---|
| A22 + this amendment | who the selector is (a person, or a no-repository session); the selector starts with BRIEF + this amendment + schema only |
| A23 | registering the candidates and scoring once |

Third-party repositories are only acquired read-only and analysed passively, at pinned commits, through the normal acquisition
path. Nothing is submitted anywhere.
