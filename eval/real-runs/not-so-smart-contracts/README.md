# First real-repository research run: crytic/not-so-smart-contracts

**Repository:** `crytic/not-so-smart-contracts` (Trail of Bits, Apache-2.0), an educational collection of real historical vulnerable contracts (The DAO, SpankChain, Rubixi, King of the Ether Throne, the Parity wallet library) and teaching examples, Solidity 0.4.x.
**Commit:** `020dbdbde3e0c2e8de5f3944e7455e438b0995d5` (2023-02-24). **Snapshot manifest:** `b0d4fb23c8487a77a609f1f60f1ef7da294ede37adcd8457b9b6a36575b838f4`; 47 files, completeness `complete`.
**Suitability and authorisation:** public, licensed for reuse, intentionally vulnerable teaching material; passive reading only. No bounty program, no live deployment, no contact, no active testing. Nothing from the repository was executed.
**Provenance and method:** read-only anonymous `git clone` through the session's git proxy (hooks disabled, no submodules); the run driver (`scripts/live-research-run.ts`, `clone:` mode) refuses unless the clone's HEAD equals the pinned SHA, produces the archive and tree with `git archive` / `git ls-tree` from that commit, and the real acquisition path verifies every file against its git object id before sealing. The **GitHub API path (T-010) is still unvalidated**: `api.github.com` is not reachable from this environment. Pipeline: acquisition, structural analysis, independent challenge, dossier, all through the real research store in a throwaway local database.

## Results against the repository's own documentation (in-scope classes only)
| Documented example | Class | Run 1 (candidate as of `deeaec8` + clone mode) | Run 3 (after general fixes) |
|---|---|---|---|
| `reentrancy/Reentrance.withdrawBalance` | reentrancy | flagged; challenge **inconclusive** (legacy `.call.value()` not modelled) | flagged; execution challenge **supports** (drain reproduced in the model) |
| `reentrancy/SpankChain` `LedgerChannel.LCOpenTimeout` (the 2018 incident) | reentrancy | flagged; inconclusive | flagged; inconclusive (token callbacks not modelled) |
| `reentrancy/DAO` `splitDAO` path | reentrancy | **missed** | **missed** (multi-step, cross-function path through `withdrawRewardFor`/`payOut`; out of reach of the current analysis) |
| `unchecked_external_call/KingOfTheEtherThrone.claimThrone` | unchecked-call | flagged | flagged |
| `unprotected_function/Unprotected.changeOwner` | access-control | flagged; supports | flagged; supports |
| `unprotected_function/WalletLibrary.initWallet` (Parity) | initializer | flagged | flagged |
| `wrong_constructor_name/Rubixi.DynamicPyramid` | access-control | flagged; supports | flagged; supports |
| `wrong_constructor_name/Missing.IamMissing` | access-control | flagged; supports | flagged; supports |
Detected 7 of 8 documented in-scope bugs in both runs. Classes the analyzer does not cover (integer overflow, bad randomness, denial of service, race conditions, forced ether, incorrect interfaces, variable shadowing, honeypots) are not scored.

## Noise and what it taught (development evidence, not independent)
Leads: run 1 **62**, run 2 52, run 3 **34**. The reductions came from general fixes to pre-0.5 idioms, each with a regression test: same-name functions are constructors (always: before 0.5 they are, from 0.5 they are illegal), with a near-miss name still flagged (that is the wrong-constructor bug); `.call.value(v)()` normalised to `call{value: v}`; `throw;` is a revert; `if (auth) _;` modifiers protect the body; pre-0.8 arithmetic inferred from legacy syntax when a file has no pragma; open setters are not access-control leads in contracts with no notion of privilege; authorities are derived from authorising guards (polarity-aware) and from constructor-recorded `msg.sender`; transfers through helpers debit the caller.
Remaining run-3 noise in scope: SpankChain channel functions flagged as access-control (open-by-design channel operations), honeypot functions, unchecked `send` results in contracts where that was the accepted idiom of the time, the attacker-side `ReentranceExploit.get_money`. Challenge outcomes on this 0.4 code are mostly **inconclusive** because the interpreter does not model tokens, many legacy builtins or multi-contract worlds.
Because the fixes were informed by this repository, run 3 is development evidence. Independent measurement is the job of the sealed third corpus.

## Not claimed
None of these leads is a confirmed vulnerability by AgentSmith's own standard (no human adjudication recorded). That the repository documents these bugs is the reason it was chosen; it is not independent confirmation of the analyzer's ability on unseen real code.
