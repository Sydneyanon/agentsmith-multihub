# USX first research run: readiness report (2026-11-28)

**Target:**
- Sherlock programme 273 (`sherlock:273`, `official_confirmed`, eligible);
- repository `scroll-tech/usx-contracts`, pinned at `9e972566deb59b4d2c499015c2557c5e5f236e3c`;
- scope: the 20 selected files under `src/`. Excluded: `src/cloak/*`, `script/`, `test/` and `tools/`.

**Scope evidence:** `docs/research-runs/usx-scope-evidence.md`. The official page's sha256 is
`1cdc83533cb8e55f89b57ae3d643cc8b16e1bdd5ea7d6b64492cbf83c19170b3`. Its structured scope names this repository, branch `main`, and
exactly this commit.

**Status:** not started. **Not ready**: 4 blockers, listed in §2.

## 1. The research path, stage by stage

Each stage is rated on six columns:
- **Impl:** implemented.
- **Conn:** connected to the pipeline.
- **Assign:** assignable.
- **Avail:** available in **production today** (release `d09d0c2`).
- **Tested:** tested.
- **Real:** demonstrated on a real bounty target.

| # | stage | code | Impl | Conn | Assign | Avail | Tested | Real |
|---|---|---|---|---|---|---|---|---|
| 1 | programme and scope verification | collector (`bounties/collect*.ts`), eligibility (`eligibility.ts`), enrichment (`enrich.ts`); scope read by hand into the evidence doc | yes | yes | — | yes | yes | **yes**: USX eligible in production; scope recorded |
| 1b | **targeted promotion** (exactly this programme, repository and commit) | `bounties/promote.ts` `target` | yes, **dev branch `d3ffd69`** | yes | — | **no**: not in `d09d0c2` | yes (3 integration tests) | no |
| 2 | repository acquisition | `acquisition/acquire.ts`, `github-source.ts` | yes | yes | yes | yes, authenticated | yes | **yes**: live check on Fly (`octocat/Hello-World`); 9 bounty repositories resolved and pinned with authenticated reads |
| 3 | commit pinning and snapshot sealing | `acquire.ts` (pinned tarball, per-file git blob check, manifest, seal), store `sealSnapshot`/`verifySnapshot` | yes | yes | yes | yes | yes | in memory on Fly only (live check); no sealed bounty snapshot in the production DB yet |
| 4 | file and dependency analysis | acquisition plan (`plan.ts`): submodules recorded as gitlinks, **not fetched** | partial | yes | yes | yes | yes | no |
| 5 | structural analysis | `analysis/solidity/*` (`structural-solidity/2` on dev; **`/2` in `d09d0c2`** as well) | yes | yes | yes | yes, **but the worker cannot run** (A7) | yes (frozen corpora) | locally only (a real bounty repo, before the citation fix) |
| 6 | hypothesis generation | structural specialists (7 classes) | yes | yes | yes | as 5 | yes | no |
| 7 | specialist and tool assignment | fixed stage order. The engine loop's selection (`engine/loop.ts`) needs drafts 0008–0010 | partial | **no** (engine loop not applied) | no | no | yes (engine tests) | no |
| 7b | Slither | `slither-step.ts`, off by default | yes | yes (opt-in) | only with binaries | **no**: no binary; the production image cannot execute it | yes (recorded output, plus one real run on dev contracts) | no |
| 8 | independent validation | execution validators (`challenge.ts`) for reentrancy and 5 other classes; others "no independent validator" | yes | yes | yes | as 5 | yes | no |
| 9 | reproduction and evidence preservation | evidence spans and blobs: yes. Foundry reproduction: engine loop only, no binary | partial | spans yes; reproduction no | reproduction no | reproduction **no** | yes | no |
| 10 | dossier | `buildDossier` / `renderDossierMarkdown`, with coverage, analyzer/build and "not evidence of absence" | yes | yes | yes | yes | yes | no |
| 10b | **bounty-scope labels** on every lead | `acquisition/bounty-scope.ts` + `buildDossier` | yes, **dev branch `d3ffd69`** | yes | — | **no**: not in `d09d0c2` | yes | no |

## 2. Blockers (all must be cleared; none is cleared by running anything now)

| # | blocker | why it blocks | what clears it |
|---|---|---|---|
| **B1** | **A7: no safe worker credential on Fly.** Fly refuses every GRANT and REVOKE. | The worker cannot record a run with read-only rights, and it must not get broad write rights. | Your decision on the worker architecture (B′ or D) after the adversarial comparison, plus the fixes you required for D. Then a release. |
| **B2** | **Targeted promotion missing from production.** `d09d0c2`'s bridge walks every eligible programme in id order. | `--max 1` could promote another programme (e.g. Cap) instead of USX. | Release containing `d3ffd69`. |
| **B3** | **The commit is not pinned in production.** `d09d0c2`'s bridge uses the default branch. | If `main` moves before the run, a different commit would be analysed, silently. | Release containing `d3ffd69` (`--commit` is required for a targeted promotion). |
| **B4** | **No scope labels in production.** | The dossier could not tell in-scope leads from out-of-scope ones. | Release containing `d3ffd69`. |

All four are code that already exists and is tested on the dev branch, or a decision that is yours. **No draft migration is needed for
the run:** the research path uses 0007 and 0012–0014, which are applied. The engine loop (0008–0010) is not on the path. Option D adds
its own small token and request-log migration; B′ adds 0015. Either is one production migration, which needs your approval.

## 3. Known limitations the first dossier will state (not blockers)
1. **Submodules are not fetched.** `usx-contracts` has submodules (e.g. libraries under `lib/`). Calls into them are unresolved, and
   the dossier's architecture section lists them as unresolved. Coverage says "complete" when every in-repository file parsed; it does
   not yet treat unresolved imports as partial. The limitation will be stated in the report and the dossier. A coverage rule for
   unresolved imports is a follow-up.
2. **Structural classes only.** Recall is 0 on benchmark-b's semantic classes: accounting, invariants, state transitions, oracles,
   economic. A USX bug in those classes would most likely be missed, and the dossier must not imply otherwise.
3. **Validators exist for reentrancy and 5 other classes.** Other leads are "no independent validator" (inconclusive).
4. **No Slither, no Foundry reproduction** in production. Both are recorded as unavailable, not as clean.
5. **Validation runs in the worker** (both B′ and D today). Until the API recomputes deterministic validation, a compromised worker
   could forge a verdict. This is one of your conditions for D.

## 4. Minimum path to the first approved run (after the worker decision)

| step | action | approval |
|---|---|---|
| 1 | Merge the chosen worker design with its required fixes. For D: API-side recomputation of deterministic validation, per-token quotas, the S11/S12 results. Also merge `d3ffd69`. Full suites, adversarial suite and frozen corpora. | your design choice |
| 2 | Build the release candidate (smoke test, push, digest); update `deploy/release.json` | release approval |
| 3 | Deploy the API and collector to it, together (drift check before and after) | deploy |
| 4 | Apply the design's single migration (D: token and request tables; B′: 0015) | production migration |
| 5 | Worker credential. D: mint a run-scoped token after step 6 and stage it as a Fly secret by pipe (never displayed); the worker has no database URL. B′: a Fly `writer` user via `mpg attach`, with output discarded. | secret / user change |
| 6 | `promote-main.js --programme sherlock:273 --repository scroll-tech/usx-contracts --commit 9e972566deb59b4d2c499015c2557c5e5f236e3c --structural --max 1 --scope-paths <the 20 paths> --scope-evidence docs/research-runs/usx-scope-evidence.md --scope-evidence-sha256 1cdc8353…70b3`. It prints the run id. | production write |
| 7 | One worker machine, `--restart no`, confined to that run (`WORKER_ONLY_RUN_ID`, `WORKER_EXIT_WHEN_RUN_DONE`). It exits afterwards. | worker activation |
| 8 | Verify: four steps succeeded; snapshot commit = `9e97256…`; manifest sealed and verified; dossier with coverage, analyzer/build, scope labels and every lead's status; 0 model-usage events. Record it in `docs/research-runs.md`. | — |

The 20 in-scope paths for `--scope-paths`:
`src/BridgedToken.sol,src/StakedUSX.sol,src/TreasuryDiamond.sol,src/TreasuryStorage.sol,src/USX.sol,src/asset-manager/AssetManager.sol,src/facets/AssetManagerAllocatorFacet.sol,src/facets/RewardDistributorFacet.sol,src/interfaces/IAssetManager.sol,src/interfaces/IScrollERC20Bridge.sol,src/interfaces/IStakedUSX.sol,src/interfaces/ITreasury.sol,src/interfaces/IUSX.sol,src/misc/ERC20Relayer.sol,src/mocks/MockAssetManager.sol,src/oft/BridgedTokenOFTAdapter.sol,src/oft/StakedUSXOFT.sol,src/oft/StakedUSXOFTAdaptor.sol,src/oft/USXOFT.sol,src/oft/USXOFTAdaptor.sol`

`src/mocks/MockAssetManager.sol` is **selected** in the official scope, so it is labelled in scope, as the programme specifies. Any lead
in it will be called out, because a mock is unlikely to be a real-impact finding.
