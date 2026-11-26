# Owner approval register (prepared 2026-11-26; NO approval is assumed or recorded here)

Approvals are recorded only by the owner, in the decision log (`research-intelligence-plan.md` section 10). This register lists what
is pending. "Blocks" says what cannot start without the decision.

| # | Decision required | Recommendation | Authorises | Does NOT authorise | Risks / consequences | Blocks |
|---|---|---|---|---|---|---|
| A1 | **T-145:** sign off the two corpus-3 adjudications (`eval/adjudications/heldout3-reentrancy.json`) | Sign off: execution and an independent assessor agree | Recording them as human-adjudicated, and correcting the validator line in the results record | Editing corpus labels; counting either as a discovery (they are benchmark labels) | Low. Not signing leaves the validator-error finding as a model-only adjudication. | Nothing critical |
| A2 | **T-147:** register candidate 3 and score corpus 4 once | Approve, with the protocol below | Exactly the protocol below | Any analyzer change after registration; re-scoring; inspecting corpus 4 before scoring | Corpus 4 is spent once scored. Results may show no gain from class A / V1–V3. Both outcomes are worth knowing. | The next held-out measurement of 5.4/5.6 |
| A3 | **T-148:** how to preserve frozen candidate history without merging or deleting | **(i) The owner pushes the tags from their own machine:** `eval/candidates.sh restore-tags`, then `git push origin refs/tags/structural-candidate-1 refs/tags/structural-candidate-2`, optionally with a GitHub tag-protection rule. **(ii) Alternatively or additionally**, a **draft PR** for this branch: GitHub keeps PR head commits even if the branch is later deleted. | Pushing two tags; or creating one draft PR, never merged | Merging, squashing, deleting branches, or rewriting history | Tags are cheap and reversible. A draft PR adds review noise but no risk. Without either, a future squash-merge plus branch deletion could orphan the frozen commits. | Nothing now; long-term reproducibility |
| A4 | **T-144 design** (`research-memory-design.md`) | Approve the design: three provenance planes, the `confirmed` rule, a single shared memory | Writing a **migration draft** and its tests on disposable databases | **Applying** any migration (separate approval A4b), or production use | A wrong design is cheap to fix before the draft, expensive after. | The human-review API, outcome recording, learning and real Priority Engine data |
| A4b | **T-144 migration apply** (later) | Decide after reviewing the draft | Applying it to the named environment | Anything else | Production schema change | Production use of research memory |
| A5 | **D1** provisional project per new program | (a) yes | Including it in the T-041 migration draft | Applying | See `opportunity-model-decisions.md` D1 | T-041 draft |
| A6 | **D2** merges as append-only rows plus a resolving view | (a) yes | as above | Applying | D2 | T-041 draft |
| A7 | **D3** one observation per program version | (a) yes | as above | Applying | D3 | T-041 draft |
| A8 | **D4** only a human `reopened` event reopens a dismissed opportunity | (a) yes | as above | Applying; any reopen API | D4 (S1 caveat) | T-041 draft |
| A9 | **D5** keep the stored state name `approved` | (a) yes | as above | Applying | D5 | T-041 draft |
| A10 | **D6** "ended" derived at read time (plus source-stated closure) | (a)+(c) | as above | Any scheduled job | D6 | T-041 draft |
| A11 | **D7** extend `bounty_opportunities` in place, expand-only | (a) yes | as above | Applying; dropping legacy columns | D7 | T-041 draft |
| A12 | **D8** priority records in T-041, with exploration-quota carry | (a) yes | as above | Any steering by those records | D8 | T-041 draft |
| A13 | **D9** T-144 kept separate from T-041 | (a) yes | Two independent migration drafts | Applying | D9 | both drafts |
| A14 | **T-057b:** the revised, preregistered synthetic experiment (`priority-engine-diagnosis.md`) | Approve as design and offline harness work | Building the scenario generator, baselines and policy v2 offline; preregistration | Changing v1; any live prioritisation or real data | Synthetic results risk being over-read; the design labels them. | Any claim that the engine beats baselines |
| A15 | **Environment network access** for the live 5.2 check (T-010): add `api.github.com` and `codeload.github.com` to this environment's allowlist | Approve (read-only public API) | Passive reads of one chosen small public repository through `GitHubSource` | Polling, discovery sources, tokens in the repository, writing to GitHub | Rate limits; no secrets needed. | Verified 5.2 through its production path |
| A16 | **T-149:** one research workflow (unify the intake chain with `repository_research`) | Approve the design task now | A design document and gap tests, no migration | Removing or altering the legacy chain in code before the design is approved | Coexisting pipelines keep diverging if this waits. | Coherent 5.0 → 5.7 flow, the human-review API, APEX/Weirdness integration |
| Standing | S1/T-061 (human-event integrity), S2/T-060 (R1 role), S4/T-138 (Hunt vs MultiHub discovery ownership), Immunefi access route, merging PRs #11–#20, production worker | Unchanged from ROADMAP section 5 | — | — | — | Any production research |

## T-147 freeze-before-score protocol (corpus 4 is a one-time evaluation set)
1. **Before scoring:**
   - Choose the candidate commit. Its analyzer must be **committed and pushed**.
   - Add it to `eval/candidates.json`: commit, tree, analyzer tree, harness blob, tag message, and `"frozenBefore": "eval/heldout4"`.
   - Commit and push that registry entry.
   - Run `eval/verify-frozen.sh`, which must pass (corpus-4 manifest `9627b82a…`, freeze commit `b9df4e5`).
2. **Score once,** in clean worktrees at the registered commits:
   - candidate 3;
   - candidate 2 (`9c2d80e`), as the comparison;
   - the baseline.

   Use the unchanged harness and record the outputs unedited as `eval/results/heldout4-run1-*`.
3. **Record:**
   - Add the result hashes to the registry.
   - Report clear and ambiguous labels separately, abstentions (validator inconclusive) separately, and per-class figures.
   - Commit, then push.
4. **After scoring:**
   - Corpus 4 is no longer held-out; any later change based on it is development evidence only.
   - Disputed labels go through adjudication (T-145), never through edits.
   - A fifth corpus is commissioned before the next claim of improvement.
