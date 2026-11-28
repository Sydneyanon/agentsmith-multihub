<!-- T-150 (APEX prior-art and novelty assessment), SECOND PASS, 2026-11-26. Research and writing only. No APEX implementation, no repository code executed. -->
> **Maintainer's note on evidence quality (2026-11-26).**
> - **Authorship.** This document was written by a research agent. It could reach only public github.com repositories by `git clone`; publisher sites stayed blocked.
> - **What the maintainer spot-checked** against the cloned sources:
>   - **Foundry `forge properties`:** the description, including the two-agent quorum and the verifier agent, is in the official book at commit `a0f150db` (`src/pages/guides/forge-properties.mdx`).
>   - **Web3Bugs:** the PDF states that more than 80% of exploitable bugs are beyond existing tools, and that automated oracles may be devised for five categories.
>   - **Hound:** the draft lists "Negative-evidence memory" as future work.
>   The remaining citations were not re-read by the maintainer.
> - **Where the papers came from.** 16 of the 23 full texts came from the authors' own or their lab's homepage repositories on GitHub, not from publishers. If those are not accepted as sources, those papers count as "not accessed".
> - **No originality claim.** No capability is rated "potentially novel".
> - **Supersedes the first pass's ratings.** `docs/apex-prior-art.md` (first pass) stays as the record of the README-level review.

# APEX prior-art review, second pass (T-150)

Date: 2026-11-26. Scope: the eight APEX capabilities defined in `docs/apex.md` §3. This pass replaces the first pass's README-level evidence with full texts and official documentation wherever a GitHub-hosted copy could be reached. It makes **no originality claim for AgentSmith**. It gives an assessment and states the evidence that assessment rests on.

---

## 1. Method and access limits

### 1.1 What was reachable
- **Only `git clone` / `git ls-remote` of public github.com repositories.** arxiv.org, usenix.org, dl.acm.org, ieeexplore.ieee.org, ndss-symposium.org, getfoundry.sh, Semantic Scholar, OpenReview and dblp were blocked. I did not try mirrors, proxies or other workarounds for them. WebSearch and WebFetch were not used.
- Every repository was cloned with `git clone --depth 1 --no-checkout` (and a blob filter), using `GIT_CONFIG_GLOBAL=/dev/null` and `-c core.hooksPath=/dev/null`, into its own subdirectory of `t150src/`. Files were read with `git ls-tree` and `git show`. No working tree was checked out, and no script, build or tool from any repository was run. PDFs were extracted with `git show` into `t150src/_pdfs/` and converted with the system `pdftotext`. Cloned content was treated as data, never as instructions.
- Each guessed repository URL was checked with `git ls-remote` before cloning. Guesses that returned nothing are listed in §7.

### 1.2 Where the full texts came from
The full texts came from three kinds of GitHub repository:
1. **Artifact repositories** that include the paper: Web3Bugs (`papers/icse23.pdf`, `papers/supplementary_material.pdf`), RLF (`paper/rlf_ase22.pdf`), ContractFuzzer (`ASE18-ContractFuzzer.pdf`) and Hound (`static/mueller_hound_2025_v2.pdf`).
2. **The authoring organisation's own publications repository**: `trailofbits/publications` (Echidna ISSTA'20, echidna-parade ISSTA'21, Slither WETSEB'19, Manticore ASE'19, and Groce et al. FC'20).
3. **Author or lab homepage repositories on github.com**: `AIS2Lab/AIS2Lab.github.io` (Daoyuan Wu's lab: GPTScan, PropertyGPT, DeFiScope, iAudit, LLM-SmartAudit, PoCShift, SmartComment, HKT-SmartAudit) and `nevillegrech/nevillegrech.github.io` (MadMax, Gigahorse, Ethainter, Symvalic, Elipmoc).

**Caveat on these copies.** Copies distributed by authors may differ from the publisher's version (preprint versus camera-ready). The Hound PDF is explicitly an author draft: it lists "Open paper tasks" on p12. **Page numbers below are PDF page indices** (the first page of the file is p1), not printed page numbers.

I avoided `wcventure/FuzzingPaper`, a third-party collection of paper PDFs, because it is a mirror.

### 1.3 Evidence marks
- **FULL TEXT READ**: the paper was obtained and the cited sections were read (abstract, approach, evaluation results, and limitations / threats / discussion). Where I read less, the table says so.
- **OFFICIAL DOCS READ**: official documentation, from the tool owner's own repository.
- **README ONLY**: only the repository README (plus file listings) was read. **It supports no claim about results or limitations.**
- **NOT ACCESSED**: not reached in this pass.

Only FULL TEXT READ and OFFICIAL DOCS READ support statements about results or limitations below. README-only material is labelled wherever it appears.

---

## 2. Source table

All repository URLs are `https://github.com/<owner>/<repo>`. SHA = the commit read.

### 2.1 FULL TEXT READ (23)
| ID | Work | Repo @ commit | File read | Sections read |
|---|---|---|---|---|
| F1 | Zhang, Zhang, Xu, Lin, "Demystifying Exploitable Bugs in Smart Contracts", ICSE 2023 | ZhangZhuoSJTU/Web3Bugs @ fd8544e84f0d6cea4b4d6a44ee62d8f7623648f4 | `papers/icse23.pdf` | whole paper |
| F2 | Web3Bugs supplementary material | same | `papers/supplementary_material.pdf` | §IV–VII (bug models) |
| F3 | Sun et al., "GPTScan: Detecting Logic Vulnerabilities in Smart Contracts by Combining GPT with Program Analysis", ICSE 2024 | AIS2Lab/AIS2Lab.github.io @ 70a0e6f66b4bc3538b144fc70c6bbbd0cf4d1cb7 | `assets/pdf/ICSE24_GPTScan.pdf` | abstract, §1, Table 1, §5 results, §6 discussion |
| F4 | Liu, Xue et al., "PropertyGPT: LLM-driven Formal Verification of Smart Contracts through Retrieval-Augmented Property Generation", NDSS 2025 | same | `assets/pdf/NDSS25_PropertyGPT.pdf` | abstract, approach, RQ1–RQ4, threats, conclusion |
| F5 | Zhong, Wu, Liu et al., "Detecting Various DeFi Price Manipulations with LLM Reasoning" (DeFiScope), ASE 2025 | same | `assets/pdf/ASE25_DeFiScope.pdf` | abstract, §VIII discussion, related work |
| F6 | "Combining Fine-tuning and LLM-based Agents for Intuitive Smart Contract Auditing with Justifications" (iAudit), ICSE 2025 | same | `assets/pdf/ICSE25_iAudit.pdf` | abstract, §VI threats, §VII limitation, conclusion |
| F7 | Wei et al., "Advanced Smart Contract Vulnerability Detection via LLM-Powered Multi-Agent Systems" (LLM-SmartAudit), IEEE TSE 2025 (author version) | same | `assets/pdf/TSE25_LLM-SmartAudit.pdf` | abstract, CVE results, threats |
| F8 | Sun, Xu et al., "Learning from the Past: Real-World Exploit Migration for Smart Contract PoC Generation" (PoCShift), ASE 2025 | same | `assets/pdf/ASE25_PoCShift.pdf` | abstract, §VI limitations and threats, conclusion |
| F9 | Zhang, Chen et al., "Detecting Code-Comment Inconsistencies in Smart Contracts by Combining LLM and Program Analysis" (SmartComment), FSE 2026 | same | `assets/pdf/FSE26_SmartComment.pdf` | abstract, §3.3, threats |
| F10 | Wei et al., "HKT-SmartAudit: Distilling Lightweight Models for Smart Contract Auditing", IEEE TIFS 2026 (author version) | same | `assets/pdf/TIFS26_HKT-SmartAudit.pdf` | abstract, threats (p13), knowledge-update paragraph (p5) |
| F11 | Grieco, Song, Cygan, Feist, Groce, "Echidna: Effective, Usable, and Fast Fuzzing for Smart Contracts", ISSTA 2020 (4 pp.) | trailofbits/publications @ 071a423477334a5bec0a690f4c121572b4a6a6b3 | `papers/echidna_issta2020.pdf` | whole paper |
| F12 | Groce, Grieco, "echidna-parade: Diverse Multicore Smart Contract Fuzzing", ISSTA 2021 (4 pp.) | same | `papers/echidna-parade_issta21.pdf` | whole paper |
| F13 | Feist, Grieco, Groce, "Slither: A Static Analysis Framework For Smart Contracts", WETSEB 2019 | same | `papers/wetseb19.pdf` | abstract, IR, limitations, evaluation setup |
| F14 | Mossberg et al., "Manticore: A User-Friendly Symbolic Execution Framework for Binaries and Smart Contracts", ASE 2019 tool paper | same | `papers/manticore.pdf` | abstract, architecture, evaluation summary |
| F15 | Groce, Feist, Grieco, Colburn, "What are the Actual Flaws in Important Smart Contracts (and How Can We Find Them)?", FC 2020 | same | `papers/smart_contract_flaws_fc2020.pdf` | abstract, threats, §5 detection estimates, conclusions |
| F16 | Su et al., "Effectively Generating Vulnerable Transaction Sequences in Smart Contracts with Reinforcement Learning-guided Fuzzing" (RLF), ASE 2022 | Demonhero0/rlf @ 258c710362d12bc42653431725669c4080d76b62 | `paper/rlf_ase22.pdf` | abstract, §3, oracles, §6 discussions |
| F17 | Jiang, Liu, Chan, "ContractFuzzer: Fuzzing Smart Contracts for Vulnerability Detection", ASE 2018 | gongbell/ContractFuzzer @ 5e5ad684d56599cbab85bfebe579f8e842e0f342 | `ASE18-ContractFuzzer.pdf` | abstract, conclusion and future work |
| F18 | Grech et al., "MadMax: Surviving Out-of-Gas Conditions in Ethereum Smart Contracts", OOPSLA 2018 | nevillegrech/nevillegrech.github.io @ 8698f7fa9e436429a03109e01ff2e25681f94891 | `assets/pdf/madmax-oopsla18.pdf` | abstract, soundness discussion, §6.4 threats |
| F19 | Brent, Grech et al., "Ethainter: A Smart Contract Security Analyzer for Composite Vulnerabilities", PLDI 2020 | same | `assets/pdf/ethainter-pldi.pdf` | abstract, §1–2 (guards, composite attacks), precision |
| F20 | Smaragdakis, Grech et al., "Symbolic Value-Flow Static Analysis…" (Symvalic), OOPSLA 2021 | same | `assets/pdf/symvalic-oopsla21.pdf` | abstract, solver-incompleteness paragraph (p16) |
| F21 | Grech et al., "Gigahorse: Thorough, Declarative Decompilation of Smart Contracts", ICSE 2019 | same | `assets/pdf/gigahorse-icse.pdf` | **abstract only**; no limitation claim drawn |
| F22 | Grech et al., "Elipmoc: Advanced Decompilation of Ethereum Smart Contracts", OOPSLA 2022 | same | `assets/pdf/elipmoc-oopsla22.pdf` | **abstract only**; no limitation claim drawn |
| F23 | Mueller, "Hound: Relation-First Knowledge Graphs for Complex-System Reasoning in Security Audits", Sept. 2025 (**author draft, not peer-reviewed**) | muellerberndt/hound @ 83ce761952b00d9090ac0911b5e618bf3753087f | `static/mueller_hound_2025_v2.pdf` | whole paper (14 pp.) |

### 2.2 OFFICIAL DOCS READ (7)
| ID | Documentation | Repo @ commit | Files read |
|---|---|---|---|
| D1 | Foundry book (official Foundry docs) | foundry-rs/book @ a0f150dbb6741028561cf78612a5f8bc5b1958ed (commit dated 2026-11-23) | `src/pages/guides/invariant-testing.mdx`; `src/pages/config/reference/testing.mdx` (§Fuzz, §Invariant); `src/pages/config/testing.mdx`; `src/pages/forge/testing.mdx` (§Fuzz testing, §Symbolic testing, §Forking, §Cheatcodes); `src/pages/guides/symbolic-testing.mdx`; `src/pages/guides/fuzz-corpus.mdx`; `src/pages/guides/fork-testing.mdx`; `src/pages/guides/forge-properties.mdx`; `src/pages/guides/upgrading-contracts.mdx` (storage-layout section); `src/pages/guides/mutation-testing.mdx` (§Limitations) |
| D2 | Echidna docs (Trail of Bits, building-secure-contracts) | crytic/building-secure-contracts @ 0e679905ce336d81b1eade9cfe924011e9073339 | `program-analysis/echidna/basic/testing-modes.md`, `.../advanced/state-network-forking.md`, `.../frequently_asked_questions.md` |
| D3 | Medusa docs | crytic/medusa @ b86c3bbafb9e80f7dcb09533006ecb15dbbbdc98 | `docs/src/testing/fuzzing_lifecycle.md`, `docs/src/testing/invariants.md`, `docs/src/project_configuration/fuzzing_config.md` |
| D4 | hevm docs | argotorg/hevm @ c981d483d2209b0b14d7724ea09affbfc9d1264b (ethereum/hevm resolves to the same commit) | `doc/src/limitations-and-workarounds.md`, `completeness-and-false-positives.md`, `when-to-use.md`, `invariant-testing-tutorial.md`, `equivalence-checking-tutorial.md`, `exploit-tutorial.md`, `symbolic.md` |
| D5 | Halmos docs | a16z/halmos @ 079bb4241d1b460baf986257d56ea86977d73451 | `docs/getting-started.md`, `examples/invariants/README.md` |
| D6 | Solidity SMTChecker docs | ethereum/solidity @ 1a85c6b9d3ca60453b90af173ff189263b1db194 | `docs/smtchecker.rst` |
| D7 | Certora Prover docs | Certora/Documentation @ 1f76f210c65bb3b458e2f7adb8aa5b40356259ae | `docs/cvl/invariants.md` |

### 2.3 README ONLY (28): no result or limitation claims drawn from these
| ID | Work | Repo @ commit (short) | Note |
|---|---|---|---|
| R1 | teEther (Krupp, Rossow, USENIX Sec 2018 per README) | nescio007/teether @ 04adf568b5dc | paper on cispa / usenix: blocked |
| R2 | VeriSmart / SmarTest (S&P'20, USENIX Sec'21 per README) | kupl/VeriSmart-public @ 36d191eca5e8 | papers on korea.ac.kr / arXiv: blocked |
| R3 | ILF (CCS'19 per README) | eth-sri/ilf @ 20a1c1583368 | PDF on files.sri.inf.ethz.ch: not GitHub |
| R4 | Smartian (ASE'21 per README) | SoftSec-KAIST/Smartian @ eca1ed1d60c8 | no PDF found |
| R5 | ConFuzzius (EuroS&P'21 per README) | christoftorres/ConFuzzius @ 4e7e1e713582 | arXiv: blocked |
| R6 | ItyFuzz | fuzzland/ityfuzz @ 80e3b4417057 | paper via dl.acm / scf.so: not reachable. README self-claims (">80% of previous hacks"; "126 vulnerabilities while Echidna finds 0 and Mythril finds 9") are **unverified** |
| R7 | SmartReco (ICSE'25 per README; "preliminary version") | zzz-sysu/smartReco @ 809e23fe878e | |
| R8 | Daedaluzz | Consensys/daedaluzz @ 2da4c25caf53 | README FAQ: good benchmark performance "Not necessarily" transfers |
| R9 | USCHunt (anonymised USENIX Sec'23 artifact) | USCHunt-Anon/USCHunt @ 66a33a64317a | |
| R10 | Securify 2.0 | eth-sri/securify2 @ 1913dfe797e5 | CCS'18 PDF on files.sri.inf.ethz.ch |
| R11 | crytic/properties | crytic/properties @ 5ea14b813ff2 | 168 properties; cheatcode FP/FN caveat |
| R12 | Mythril | Consensys/mythril @ 125914a6eae8 | |
| R13 | SmartBugs 2.0 | smartbugs/smartbugs @ a24600362277 | 28 tools; warns about unmaintained prototypes; paper on arXiv |
| R14 | SB Curated dataset | smartbugs/smartbugs-curated @ 230e64912347 | DASP taxonomy |
| R15 | Scribble | Consensys/scribble @ 8fef54864fa7 | |
| R16 | KEVM | runtimeverification/evm-semantics @ fbb2edbb8e84 | |
| R17 | DeFiHackLabs | SunWeb3Sec/DeFiHackLabs @ 8a2b37f17377 | README: "915 incidents included" |
| R18 | PoCo (TOSEM 2026 per README) | ASSERT-KTH/PoCo-public @ a136195a1ac8 | artifacts only; paper on arXiv |
| R19 | AEG-PoC ("Prompt to Pwn") dataset | Crimson798/AEG-PoC @ 5862a191c3eb | |
| R20 | Sailfish (S&P'22 per README) | ucsb-seclab/sailfish @ bbab10cde68c | state-inconsistency (reentrancy, TOD) |
| R21 | Vandal | usyd-blockchain/vandal @ d2b004326fee | tech report on arXiv |
| R22 | Gigahorse toolchain repository | nevillegrech/gigahorse-toolchain @ 1b06cef82f0a | paper itself: F21 |
| R23 | TxSpector | OSUSecLab/TxSpector @ e8304519412f | transaction-trace attack detection |
| R24 | EF/CF | uni-due-syssec/efcf-framework @ 1a7b2da6e4b5 | AFL++-based EVM fuzzing; paper on arXiv |
| R25 | DeFiTainter | kongqp/DeFiTainter @ 554559acf84d | inter-contract taint for price manipulation |
| R26 | Horus (FC'21 per README) | christoftorres/Horus @ d0feb2a65c2f | PDF on orbilu.uni.lu: not GitHub |
| R27 | ScaBench (audit benchmark; Nethermind AuditAgent scorer) | scabench-org/scabench @ eec0020939a4 | README: new datasets are added "to prevent models from being trained on known results" |
| R28 | Trail of Bits `skills` (agent skills, including `fp-check`, `property-based-testing`, `spec-to-code-compliance`, `variant-analysis`, `building-secure-contracts`) | trailofbits/skills @ 149d7b21f406 | |

Repositories whose paper was read (Echidna, echidna-parade, Slither, Manticore, MadMax, GPTScan, PropertyGPT, DeFiScope, RLF, ContractFuzzer, Web3Bugs, Hound) were also cloned: crytic/echidna @ ca4b373edd8a, crytic/echidna-parade @ 827a8c28abab, crytic/slither @ 97c1d10d8107, trailofbits/manticore @ cdf6c4b49603, nevillegrech/MadMax @ 7572e906c5b3, VPRLab/GPTScan @ 29cd36a12f01, Pr0pertyGPT/PropertyGPT @ 24a80982a6d3, AIS2Lab/DeFiScope @ 85c22cbf615c. They are counted once, under FULL TEXT READ.

### 2.4 NOT ACCESSED in this pass
- First-pass sources not re-opened: Aderyn (Cyfrin/aderyn), SmartCheck, Oyente, echidna FC'20 poster, sFuzz paper. The **sFuzz repository** (duytai/sFuzz @ ce87440a59ae) was opened, but its README has build notes only.
- Papers named in the brief with no reachable GitHub copy: Sailfish, SmartPulse, Clockwork Finance, DeFiTainter (paper), SmartState, eThor, Mau, EF/CF (paper), SymGPT, LLM4Vuln, SmartInv, FlashSyn, DeFiPoser, DeFort, DeFiRanger, Harvey, A1, solc-verify, SmartShield, TxSpector (paper), Securify (CCS'18), teEther, VeriSmart, SmarTest, ILF, Smartian, ConFuzzius, ItyFuzz, SmartReco, SmartBugs 2.0, PoCo, Prompt to Pwn, the USCHunt paper, and every DeFi-attack SoK. See §6.

---

## 3. Per-capability analysis

Classification scale, least to most novel: **existing < integration < meaningful extension < potentially novel**. "Potentially novel" requires a specific gap that the full texts read leave explicitly open, plus a stated evidence requirement.

### Capability 1: Execution Path Explorer
**APEX intent (apex.md §3).** Construct and explore paths across functions, modifiers, internal helpers, contracts and transaction sequences. It builds on `trace.ts` (inlined effect traces), `simulate.ts` and the per-function reachability challenge. Open items: a multi-contract world, path-explosion control, transaction sequences and storage aliasing.

**Existing methods and tools, and what they demonstrably do**
- **Foundry invariant and symbolic testing [D1].**
  - *Invariant testing.* Invariant tests run random call sequences against `targetContract` / `targetSelector` (and `excludeSelector`) and check `invariant_*` functions after each call (`guides/invariant-testing.mdx`). Defaults: `runs` 256, `depth` 500, `fail_on_revert` false, `shrink_run_limit` 5000 (`config/reference/testing.mdx` §Invariant). The guide's example `foundry.toml` uses depth 100, which is an example value, not the default. Multi-contract invariants are written through handlers (§"Multi-contract invariants").
  - *Symbolic mode.* With `--symbolic`, `check*`/`prove*` tests are explored symbolically, and `invariant*` functions "are explored as bounded symbolic call sequences" (`forge/testing.mdx` §Symbolic testing). Bounds: `max_depth`, `max_paths`, `max_solver_queries`, `invariant_depth`, dynamic-length settings and `symbolic_call_targets` (`guides/symbolic-testing.mdx`).
  - *Maturity.* The book labels symbolic testing "currently an MVP".
- **hevm [D4].** hevm explores `invariant_` functions symbolically over "every sequence of calls up to a given length, with symbolic arguments and callers" (`invariant-testing-tutorial.md`). It also runs symbolic execution against forked mainnet state (`exploit-tutorial.md`, Truebit example).
- **Halmos [D5].** Halmos runs symbolic tests over Foundry-style tests. Its invariant examples say it "considers only unique state-generating call sequences" (`examples/invariants/README.md`).
- **SMTChecker CHC [D6].** The CHC engine models the contract as a loop over public functions, "over an unbounded number of transactions". External calls to unknown code "can do anything" (`smtchecker.rst`, §CHC).
- **Echidna and Medusa [F11, D2, D3].**
  - Both generate and mutate call sequences, using a coverage-guided corpus.
  - Echidna (ISSTA'20) reached 19 of 40 randomly chosen assertion targets in 2 minutes, versus 15 of 40 for solfuzz/MythX, and 28 of 40 on Tether [F11 p3]. The authors report 100% of the *reachable* targets in the first set [F11 p3].
- **Static IR and decompilers [F13, F21, F22].**
  - Slither's SlithIR (SSA, inheritance graph, CFG) [F13 p1].
  - Gigahorse "can decompile over 99.98% of deployed contracts" [F21 p1, abstract].
  - Elipmoc resolves operands "at a rate of 99.5% (compared to 62.8% for Gigahorse)" [F22 p1, abstract].
- **Symvalic [F20].** Symvalic reports "83–96% statement coverage" with higher precision than past tools [F20 p1].

**Limitations stated by the authors or the docs**
- **Bounds.**
  - Foundry: a symbolic `PASS` "does not cover skipped dynamic lengths, deeper invariant sequences, larger loop bounds, unmodeled behavior, arbitrary unknown external code" [D1 `forge/testing.mdx` §Results]. Gaps "include gas accounting, Cancun+ `SELFDESTRUCT`, arbitrary unknown external code" [D1 §Limitations].
  - hevm explores loops only "up to fixed depth k" [D4 `limitations-and-workarounds.md`]. A symbolic `CALL` target stops exploration unless `--only-deployed` is set [D4 `completeness-and-false-positives.md`].
- **Incompleteness from the solver.**
  - SMTChecker reports "might happen" when the solver times out [D6].
  - Symvalic: "size limitations of bottom-up reasoning and inference-depth limitations of top-down reasoning are causes for incompleteness" [F20 p16].
- **Sequence choice.**
  - Echidna could not generate the "add to blacklist, then destroy funds" target, because "there is no simple coverage-feedback to encourage" it. A swarm prototype found it in under five minutes [F11 p3].
  - Default sequence length 100 is "a reasonable compromise" for short campaigns [F11 p4].
  - Foundry: `check_interval` "can miss bugs that break and then restore the invariant between checks" [D1 invariant guide].
- **Static IR.** SlithIR's "principal omission is the lack of formal semantics", and it is "too high-level to accurately reflect low-level information, such as the gas computation" [F13 p5].
- **Path-insensitivity in LLM-plus-static hybrids.** GPTScan's static part "is not path-sensitive… It could be improved by introducing symbolic execution engines" [F3 p11].

**What AgentSmith proposes.** Source-level path construction across modifiers, helpers and contracts on the shared 5.3/5.4 model, extended to a multi-contract world and to transaction sequences, with explicit control of path explosion and storage aliasing (apex.md §3, row 1).

**Assessment: existing / integration (unchanged from the first pass, with stronger evidence).** Every listed open item (multi-contract worlds, bounded sequences, path bounding, symbolic storage) is available in documented, maintained tools [D1, D4, D5, D6]. Foundry now also unifies fuzzing and symbolic sequences in one runner [D1]. No full text read leaves "paths across modifiers and helpers" explicitly open as a research problem.
- *Evidence that would be needed for anything higher:* measured reachability on Daedaluzz-style mazes and real protocols, at equal budget, against Foundry (fuzz and symbolic), Medusa, Echidna, hevm and Halmos.

---

### Capability 2: Assumption Breaker
**APEX intent.** Extract explicit and implicit assumptions (guards, invariants, trusted callers, ordering, value ranges, oracle freshness), record them as first-class records, and investigate how each could fail. It builds on guard extraction.

**Existing methods and tools, and what they demonstrably do**
- **The oracle gap, quantified [F1].**
  - "Most existing works (35 out of 37) rely on general and simple oracles, or hand-coded specifications" [F1 p5].
  - Even under over-approximation, "only 20% exploitable bugs can be detected by existing works". Slither and Oyente detected no machine-unauditable bug (MUB) [F1 p5, Findings 2–3].
  - Five of seven MUB categories (60% of MUBs) "have general abstract models which may serve as oracles for future automated tools" (Finding 10) [F1 p10].
- **Implicit relations as the oracle [F1, F2].**
  - Inconsistent state updates come from state variables "with implicit correlations" [F1 p6].
  - The supplement's bug model: "Inferring such co-occurrence relations is the key to detecting these bugs" [F2 p6].
  - ID-uniqueness bugs require inferring "if some variables are intended to be an ID" [F2 p6].
- **LLM property generation [F4].**
  - PropertyGPT retrieves existing human-written (Certora) properties from a vector database, adapts them with an LLM, and checks them with its own prover [F4 p1].
  - It reports 80% recall against ground truth, 26 of 37 CVEs/incidents detected, and 12 zero-days ($8,256 in bounties) [F4 p1]. On 13 CVEs it detected 9, versus GPTScan's 5 [F4 p10].
- **Comments as specifications [F9].** SmartComment found 203 valid code-comment inconsistencies in 1,000 contracts, at 79.9% precision [F9 p1].
- **Guards modelled explicitly [F19].** Ethainter models guards and "tainted guards": "the tainting of a guard condition successively enables more tainting, which invalidates guards that might locally appear sound" [F19 p3]. It reports 82.5% precision on end-to-end vulnerabilities [F19 p1].
- **Assumptions as annotations in an agent's model [F23].**
  - Hound's graphs carry "typed annotations (observations, assumptions)" [F23 p2–4].
  - Its planning prefers "salient contradictions between assumptions and observations" [F23 p6].
- **Property harnesses [D1–D3, D5].** Foundry handlers and ghost variables, Medusa's function-level and system-level invariants, and Echidna property and assertion modes all check *written-down* properties.
- **The analysis's own assumptions.**
  - Foundry symbolic counterexample artifacts record `bounds`, `solver` and `assumptions`. The docs warn that unnecessary `require`/`vm.assume` "can exclude the bug you want to find" [D1 `guides/symbolic-testing.mdx`].
  - Certora lists its unsound features: preserved blocks, filters, reverting invariants, and "invariants that depend on the environment or on the state of external contracts" [D7].
  - SMTChecker "trusted" external-call mode "can give unsound results if the assumptions are inconsistent" [D6].

**Limitations stated by the authors**
- PropertyGPT:
  - Lacks an equivalence checker between Certora-style and generated properties (manual review instead).
  - External validity is limited to 13 CVEs [F4 p13].
  - Bounded model checking is "capped at three by default" [F4 p7].
  - Future work is to add "documentation" context and "richer property knowledge" [F4 p13].
- hevm: symbolic execution "does not automatically generate postconditions… these postconditions… need to be explicitly written" [D4 `when-to-use.md`].
- Groce et al.: only 91 of 246 audit findings (37%) could plausibly be found with user-defined properties [F15 p11]. Almost 25% of the high-severity, low-difficulty findings would be missed "even with high-effort, high-expertise construction of custom properties" [F15 p14].
- Web3Bugs:
  - Atomic business flows "are usually implicit (suggested by boolean flags serving as locks and explicit time bounds)" [F1 p10].
  - 16% of Code4rena MUBs are implementation-specific with "no general oracle" [F1 p7].

**What AgentSmith proposes.** An assumption catalogue as first-class records, seeded by guard extraction. It extracts implicit assumptions (trusted callers, ordering, ranges, oracle freshness) and attempts each violation, with provenance (apex.md §3, row 2, and §4).

**Assessment: meaningful extension, at most.**
- *Why not higher:*
  - The full texts read already cover large parts of this: LLM-derived properties checked by a prover [F4], comment-derived specifications with differential confirmation [F9], explicit guard modelling including guard compromise [F19], and an agent that keeps assumption annotations and steers toward assumption–observation contradictions [F23].
  - Foundry already records the analysis's own assumptions per counterexample [D1].
- *What remains open, explicitly:* Web3Bugs leaves *automatic* oracles for MUB categories C1, C3–C6 open (Finding 10) [F1 p10]. PropertyGPT shows only that retrieval works when a similar human property exists [F4 p11]. No full text read reports a systematic catalogue of *environmental* assumptions (oracle freshness, token behaviour, trusted roles) whose violations are each attempted and recorded.
- *Why still not "potentially novel":* SmartInv, LLM4Vuln and SymGPT could not be read and may cover this, so I cannot claim the gap is open across the literature.
- *Evidence needed:*
  - Held-out Web3Bugs-style C4/C6 bugs disclosed after the design freeze.
  - Precision and recall of automatically derived assumptions and their violations, against PropertyGPT, GPTScan, SmartComment and hand-written crytic/properties.
  - An ablation showing which violations needed implicit (not written) assumptions.

---

### Capability 3: Protocol Interaction Explorer
**APEX intent.** Interactions among contracts, integrations, oracles, tokens, lending, vaults, bridges and external dependencies. Open items: models of external protocols and tokens, economic semantics, and unresolved/imported code.

**Existing methods and tools, and what they demonstrably do**
- **Price manipulation is the hardest class in the data [F1].**
  - Price oracle manipulation is 34% of real-world exploits but 6% of contest bugs.
  - Its "auditing difficulty… is significantly higher than others" [F1 p6].
- **LLM-based price-manipulation detection [F5].** DeFiScope reports 80% recall on real attacks, 96% precision on suspicious transactions, and zero false alarms on benign ones. It helped confirm 147 attacks, 81 of them previously unknown [F5 p1].
- **Forked real state and multi-contract harnesses [D1, D2, D4].**
  - Foundry: fork testing pinned to blocks, multi-fork `createFork`/`selectFork` (`guides/fork-testing.mdx`), and multi-contract system handlers including an oracle `updatePrice` action (`guides/invariant-testing.mdx`).
  - Echidna: on-chain fuzzing from an RPC state at a fixed block [D2 `state-network-forking.md`].
  - hevm: finds the Truebit exploit from deployed bytecode at the pre-attack block, given a "buy-then-sell is never profitable" property [D4 `exploit-tutorial.md`].
- **External calls as adversarial.**
  - SMTChecker treats every external call as unknown code and can synthesise reentrant calls in counterexamples [D6].
  - Foundry `call_override` "overrides unsafe external calls… useful for e.g. performing reentrancy checks" [D1 config reference].
  - Certora "strong" invariants are asserted around unresolved external calls [D7].
- **Composite and inter-contract static analysis.** Ethainter (multi-transaction taint escalation) [F19]. README only: DeFiTainter (inter-contract taint for price manipulation) [R25], SmartReco (cross-DApp read-only reentrancy) [R7], ItyFuzz (forking, flash-loan modelling) [R6].
- **Exploit migration [F8].** PoCShift migrates exploits from documented incidents to similar code. It produced valid PoCs for 62 of 67 cases, and found 256 vulnerable contracts among 979,512 [F8 p1].

**Limitations stated by the authors or the docs**
- DeFiScope "detects only single-transaction attacks"; multi-transaction attacks spanning e.g. 48 hours are "challenging" [F5 p11].
- Certora: "the Prover only checks the main contract's methods for preservation", so invariants that depend on external contracts can be falsified silently [D7].
- PoCShift: valid PoCs require "orchestrating transaction sequences" across "cross-contract interactions" [F8 p11]. The approach depends on existing PoCs, and the gap until PoCs exist is acknowledged [F8 p10].
- hevm: a symbolic address in `CALL` stops exploration [D4].
- Web3Bugs excludes attacks that involve off-chain components [F1 p3]. Cross-chain projects are a separate DeFi category [F1 p3, Table I].

**What AgentSmith proposes.** Models of external protocols and tokens, economic semantics, and handling of unresolved/imported code, all on the shared 5.3 representation (apex.md §3, row 3).

**Assessment: integration.**
- *What exists:* forked-state exploration, adversarial external-call models, price-manipulation detection and exploit migration are all documented.
- *What I could not verify:* the bridge, oracle and flash-loan attack-*synthesis* literature (FlashSyn, DeFiPoser, Clockwork Finance, DeFort) could not be read. I therefore cannot say whether "economic semantics" is open.
- *Evidence needed for more:*
  - Reproduce held-out DeFiHackLabs incidents [R17] that DeFiScope (single-tx), ItyFuzz and hevm-on-fork do not reach in equal budget.
  - Report which protocol classes (bridges, lending, vaults) are actually modelled.

---

### Capability 4: Temporal Sequence Hunter
**APEX intent.** Unusual sequences of valid operations, state transitions, upgrades, partial operations and ordering/MEV assumptions. It builds on bounded two-call re-entrancy orderings.

**Existing methods and tools, and what they demonstrably do**
- **Sequence fuzzing.**
  - Echidna: corpus sequences, with rarer sequences "replayed and mutated more frequently" [D2 FAQ].
  - Medusa: `callSequenceLength`, corpus of coverage-increasing sequences [D3 `fuzzing_lifecycle.md`].
  - Foundry: `depth`, plus `max_time_delay` and `max_block_delay`, which fuzz "both the call sequence and the time or block distance between calls", for vesting, auctions, TWAPs and cooldowns [D1 invariant guide §Time-based campaigns].
- **Diversity of sequences [F12].** echidna-parade's swarm testing and length diversification found 2.44 of 3 seeded violations on average, versus 1.6 for Echidna (p ≤ 0.005) [F12 p3]. On MakerDAO DSS, some targets were covered "only once in total experiment runtime of over 36 CPU days" [F12 p4].
- **Learned sequence policies [F16].** RLF models fuzzing as an MDP with a vulnerability-plus-coverage reward. It reports detecting "8%–69% more vulnerabilities within 30 minutes" [F16 p1].
- **Bounded exhaustive sequences.**
  - hevm invariant mode: "a `[PASS]` means no sequence of calls up to that length breaks the invariant" [D4].
  - Foundry symbolic `invariant_depth` [D1].
  - SMTChecker CHC: unbounded transactions [D6].
- **Business-flow analysis [F1].**
  - Privilege escalation via "unexpected business flow to a sensitive operation" [F1 p7].
  - Atomicity violations, where business flows interleave [F1 p7].
  - The authors' own Slither-based tool enumerates operation sequences up to length 5, pruned by read-write dependencies [F1 p11].
- **Composite multi-transaction escalation [F19 p1–3].**
- **Upgrades [D1].** Foundry gives storage-layout diffing and manual upgrade tests that check that "state is preserved across the upgrade" and that only authorised accounts can upgrade (`guides/upgrading-contracts.mdx`). USCHunt classifies proxies (README only) [R9].

**Limitations stated by the authors**
- Atomicity violations "are slightly harder to find… The reason is that it is difficult to determine business flows and if they need atomicity" [F1 p7].
- DeFiScope cannot handle multi-transaction attacks [F5 p11].
- RLF: its performance "heavily depends on the number of vulnerabilities for training". Its action space degrades as the number of functions grows. Arguments are random, not chosen [F16 p10].
- Echidna: sequences without coverage feedback, such as the blacklist example, are hard [F11 p3].
- Foundry: `check_interval` > 1 can miss transient violations [D1].

**What AgentSmith proposes.** General sequence search beyond two-call orderings, upgrade and migration states, partial operations, and ordering/MEV-style assumptions (apex.md §3, row 4).

**Assessment: integration, possibly a meaningful extension in two narrow areas.**
- *General sequence search exists* [D1–D4, F11, F12, F16].
- *Two areas the full texts leave open:*
  - **Inference of business flows and their atomicity requirements**, stated as the difficulty in [F1 p7, p10]. Note that this is an *oracle* problem: once the flow is known, existing sequence fuzzers can search it.
  - **Sequences that span an upgrade.** Foundry documents layout diffing and hand-written upgrade tests only [D1].
- *Not "potentially novel":* the upgrade-security literature (the USCHunt paper and others) and multi-transaction DeFi synthesis could not be read.
- *Evidence needed:*
  - Findings that require (a) an upgrade mid-sequence, or (b) an abandoned partial flow, or (c) an inferred atomic flow.
  - Show that Foundry/Medusa/Echidna with comparable handlers, and hevm at comparable depth, miss them at equal budget.

---

### Capability 5: Novel Hypothesis Generator
**APEX intent.** Original, evidence-backed hypotheses beyond fixed templates. It must go beyond seven deterministic template specialists. "How novelty is defined and measured" is open.

**Existing methods and tools, and what they demonstrably do**
- **Template-bound LLM detectors.**
  - GPTScan breaks "ten common logic vulnerability types into scenarios and properties" [F3 p4, Table 1]. It reports precision above 90% on token contracts and 57.14% on Web3Bugs, recall above 70%, and 9 new vulnerabilities [F3 p1].
  - LLM-SmartAudit's targeted mode "covers 40 scenarios" [F7 p15]. It reports 12 of 13 CVEs [F7 p11].
- **Fine-tuned detectors [F6, F10].**
  - iAudit reports F1 91.21%, but its generated causes agree with ground truth only "about 38%" [F6 p1].
  - HKT-SmartAudit distils small models [F10].
- **Template-free agentic hypotheses [F23].**
  - Hound keeps "long-lived vulnerability hypotheses whose confidence is updated as evidence accrues" [F23 p1].
  - On a five-project ScaBench subset it reports recall of 31.2% versus 8.3% and precision of 9.3% versus 12.2%, against a baseline LLM analyzer [F23 p11].
- **Agentic bug hypotheses confirmed by executable tests [D1].** `forge properties` "runs coding agents independently against your contracts". Each agent writes failing tests for suspected bugs. Forge "reruns those tests on several seeds, groups the reproducible failures by root cause, and reports the bugs that enough agents found" (default quorum 2). An optional verifier "tries to disprove each reported bug" in four ways (`guides/forge-properties.mdx`). The feature is marked experimental.
- **Retrieval or migration of past knowledge.** PropertyGPT adapts retrieved properties [F4]. PoCShift adapts past PoCs [F8].

**Limitations stated by the authors or the docs**
- Generalisation:
  - LLM-SmartAudit: "Complex vulnerabilities, particularly those arising from emerging or previously unreported issues, remain challenging to detect" [F7 p15].
  - HKT: training "may limit generalization to unseen or emerging threats" [F10 p13].
- Precision:
  - Hound "still emits many plausible, ultimately incorrect hypotheses" [F23 p12].
  - iAudit: "hallucinations may still occur" [F6 p11].
- Agreement is not proof: "Agreement between agents is evidence to investigate, not proof… independent agents can make the same mistake. A verifier verdict is also evidence, not a proof" [D1 `forge-properties.mdx` §Verify].
- 16% of Code4rena MUBs are implementation-specific [F1 p7]. By construction, templates cannot cover them.

**What AgentSmith proposes.** Evidence-backed hypotheses beyond fixed templates, with origin provenance (`apex/<capability>@version`), independent validation, and model calls subject to separate approval (apex.md §3, row 5, and §4).

**Assessment: integration (lowered from the first pass's "meaningful extension at most").**
- *Why lowered:* the first pass could not see two things that the full texts and official docs now show. Template-free LLM/agent hypothesis generation with persistent confidence exists [F23]. Executable, multi-agent, quorum- and verifier-checked hypothesis generation is now a documented Foundry feature [D1].
- *What is not shown by any source read:* a *measured* notion of novelty, meaning hypotheses that led to confirmed findings and lie outside the detector/template catalogue and the retrieval corpus.
- *What would be required for "meaningful extension":* a blinded evaluation with exactly that measure, on targets disclosed after the design freeze, against `forge properties`, Hound, GPTScan and PropertyGPT at equal model budget. Without it, the capability is a combination of existing techniques.

---

### Capability 6: Adaptive Search Engine
**APEX intent.** Prioritise promising and unexplored paths by evidence, coverage gaps, novelty and measured discovery value. Learned guidance comes only from independently confirmed outcomes.

**Existing methods and tools, and what they demonstrably do**
- **Coverage-guided corpora.**
  - Echidna adds a sequence when a transaction adds coverage. Coverage combines PC, end status and frame depth, and rarer sequences are mutated more [D2 FAQ].
  - Medusa: per-opcode coverage arrays, corpus pruning [D3].
  - Foundry: `corpus_dir` enables coverage-guided fuzzing [D1 `fuzz-corpus.mdx`].
- **Cross-engine exchange [D1].**
  - `--symbolic-seed-corpus` writes symbolic solutions into the fuzz corpus.
  - `--symbolic-use-fuzz-corpus` imports corpus entries "as path-priority hints".
  - `--symbolic-use-fuzz-frontiers` targets "branch-frontier records produced by fuzzing" (`guides/symbolic-testing.mdx`; `fuzz-corpus.mdx` lists `frontier_dir`).
  - Fuzz targets: optimisation mode maximises an `int256` invariant [D1].
- **Configuration diversity [F12].** echidna-parade diversifies configurations (swarm function omission, sequence length) across generations [F12 p2–3].
- **Learned policies.** RLF uses a vulnerability-plus-coverage reward [F16]. ILF (README only) [R3].
- **Agent planning [F23].** Hound uses "coverage-versus-intuition planning". Intuition prefers "high expected impact (value at risk), salient contradictions…, cross-component interactions" [F23 p1, p6]. A project-wide PlanLedger aggregates activity [F23 p6, p9].
- **Static prioritisation [F1].** Web3Bugs guided auditing prioritised bug types by project category [F1 p7, p11].

**Limitations stated by the authors or the docs**
- "Determining the best amount of time to run a fuzzer is still an open research question" [D2 FAQ].
- RLF depends on training data and an action-space design [F16 p10].
- Daedaluzz (README only): tuned performance may not generalise [R8].
- Hound's future work: "prioritize contradiction-rich components and reuse belief ledger to avoid re-probing low-signal areas" [F23 p12].

**What AgentSmith proposes.** Prioritisation from evidence, coverage gaps, novelty and *measured discovery value*, with budget allocated by the Adaptive Research Priority Engine. Learned guidance only from independently confirmed outcomes (apex.md §3, row 6; §2 table).

**Assessment: integration, possibly a meaningful extension.**
- *What exists:* coverage-guided prioritisation, fuzz↔symbolic exchange, configuration diversity, learned single-engine policies and agent coverage/intuition planning [D1–D3, F12, F16, F23].
- *Not found in any full text read:* allocation of budget **across heterogeneous engines (static, symbolic, fuzz, LLM agent) by independently confirmed discovery value**. Foundry's exchange is driven by coverage frontiers, Hound's by coverage and intuition, and RLF's reward comes from built-in oracles, not independent confirmation.
- *Why not "potentially novel":* no author states this as an open problem, and the ensemble-fuzzing and LLM-agent literature behind blocked sites was not read.
- *Evidence needed:* an ablation against fixed and round-robin portfolios and single engines at equal compute. Report time to first *independently confirmed* finding and unique confirmed findings.

---

### Capability 7: Counterexample and Validation Engine
**APEX intent.** Try to refute hypotheses, produce reproducible counterexamples, validate invariant violations, and minimise them under a real compiler and EVM. It never assigns status itself.

**Existing methods and tools, and what they demonstrably do**
- **Foundry [D1].**
  - "A failing symbolic result is reported only after Forge confirms it with the concrete executor."
  - Artifacts are schema-versioned JSON with `calls`, `bounds`, `solver`, `assumptions` and `replay.status` (`confirmed`).
  - `--replay-symbolic-artifact` replays without the solver. `--emit-regression` writes a Solidity regression test.
  - `Incomplete` must be treated "as an unresolved result" (`guides/symbolic-testing.mdx`).
  - Shrinking: `shrink_run_limit`. Minimisation: `forge fuzz tmin`/`cmin`. Failures persist separately from the corpus (`fuzz-corpus.mdx`).
- **Validation by multiple seeds and an adversarial verifier [D1].** In `forge properties`, a reported bug must fail on every seed. The verifier tries four disproofs ("intended or allowed", "impossible state or cheats", "misreads the code", "only hardening") and reports `confirmed` only if all four fail (`forge-properties.mdx`).
- **hevm [D4].** hevm "attempts to validate every counterexample", marks `[validated]` or `[not reproducible]`, and emits completeness warnings.
- **Echidna [F11 p2].** Counterexamples are "automatically minimized to report the smallest and simplest sequence".
- **Exploit and PoC generation.** PoCShift: 62 of 67 valid PoCs without false positives [F8 p1]. Ethainter confirmed warnings by automatic exploit generation (destroying "over 800 contracts on the Ropsten network") [F19 p1]. teEther, ItyFuzz and PoCo are README only [R1, R6, R18].

**Limitations stated by the authors or the docs**
- A Foundry `PASS` "is also bounded by the artifact's recorded assumptions and search limits; it is not an unbounded proof" [D1].
- Halmos reports only `Panic(1)` assertion violations, not other reverts [D5].
- SMTChecker counterexamples "may also be a false positive" because of abstractions [D6].
- Certora: reverting invariants can make a false invariant pass [D7].
- crytic/properties (README only): cheatcodes may cause false positives or negatives [R11].
- Hound lists "test-driven confirmation" as future work [F23 p12].
- PoCShift prioritises "immediate demonstrable threats". Validation-failed cases are not categorised [F8 p10–11].

**What AgentSmith proposes.** Executable counterexamples under a real compiler and EVM, minimisation, and an invariant representation (T-152). Evidence only: status comes from the independent 5.6 stage (apex.md §3, row 7; §4.3).

**Assessment: existing.** Concrete-replay-confirmed counterexamples, minimisation, recorded bounds and assumptions, regression emission, multi-seed confirmation and an adversarial disproof step are all documented features of maintained tools [D1, D4]. The first pass's suggestion that recording what a "no counterexample" result depends on would be good engineering is now implemented in Foundry [D1]. The independence rule (the generator never assigns status) is an AgentSmith governance property, not a research contribution.

---

### Capability 8: Durable Discovery Memory
**APEX intent.** Preserve explored paths, successful strategies, false positives, confirmed vulnerabilities and *missed* findings. Needs a schema, a learning interface and contamination controls.

**Existing methods and tools, and what they demonstrably do**
- **Campaign-level persistence [D1–D3].**
  - Foundry keeps a corpus (coverage-increasing inputs), failure persistence and branch frontiers, which are explicitly distinct artifacts [D1 `fuzz-corpus.mdx`]. Forge also writes `cache/properties/report.json` [D1].
  - Echidna: corpus directory and RPC cache [D2].
  - Medusa: `corpusDirectory` reused "during the next fuzzing campaign" [D3].
- **Per-project agent memory [F23].**
  - "Living knowledge graphs that persist across sessions", plus a persistent hypothesis store with confidence and status [F23 p2, p5].
  - A per-project coverage index and a project-wide PlanLedger [F23 p5–6].
- **Retrieval memory of past knowledge.**
  - PropertyGPT's vector database of human-written properties [F4 p1–4].
  - PoCShift's template library abstracted from past PoCs [F8 p1].
  - HKT mentions a "Knowledge Update Mechanism: A web crawler scrapes…" for teacher knowledge [F10 p5].
- **Curated corpora.** Web3Bugs [F1]. DeFiHackLabs, ScaBench and SB Curated are README only [R17, R27, R14]. ScaBench's README notes that it adds datasets to avoid training contamination [R27].

**Limitations stated by the authors**
- Hound lists **"Negative-evidence memory: Record strong refutations in the belief ledger and propagate them across sessions to avoid re-probing low-signal areas"** as future work [F23 p12]. Its persistence is per project [F23 p5].
- HKT: "the model's knowledge remains static post-training… This lack of an automated knowledge-update mechanism presents a risk of performance degradation over time" [F10 p13].
- PoCShift depends on PoC availability, and acknowledges the "gap between when incidents occur and when PoCs become available" [F8 p10].
- Web3Bugs: learning-based techniques "were trained with bugs which fell into the machine-auditable categories" [F1 p5].

**What AgentSmith proposes.** Durable, cross-target memory of paths, strategies, false positives, confirmed and missed findings in the 5.1 store, a learning interface fed only by independently confirmed outcomes, and contamination controls (apex.md §3, row 8; §6).

**Assessment: meaningful extension (provisional, unchanged).**
- *What exists:* campaign-level and per-project memory [D1–D3, F23]; retrieval of past properties and PoCs [F4, F8].
- *Explicitly left open by authors:* refutation (negative-evidence) memory across sessions [F23 p12]; automated knowledge update [F10 p13].
- *Not found in the full texts read:* memory **across targets** that records false positives and *missed* findings and feeds back into search under contamination controls.
- *Why not "potentially novel":* the explicitly open item in Hound is narrower (within-project refutations), and the 2025–2026 agent-auditing literature (PoCo, A1, LLM4Vuln and others) was not readable.
- *Evidence needed:*
  - A longitudinal evaluation over a sequence of held-out targets, with memory on and off.
  - Time to first confirmed finding and false-positive rate on later targets.
  - Leakage controls showing that memory of known incidents does not trivially "rediscover" them.

---

### 3.9 Summary of classifications
| # | Capability | First pass | Second pass | Main evidence |
|---|---|---|---|---|
| 1 | Execution Path Explorer | existing / integration | **existing / integration** | D1, D4, D5, D6, F11, F20 |
| 2 | Assumption Breaker | integration, possibly meaningful extension | **meaningful extension, at most** (conditional) | F1, F2, F4, F9, F19, F23, D1, D7 |
| 3 | Protocol Interaction Explorer | integration | **integration** | F1, F5, F8, D1, D2, D4, D6, D7 |
| 4 | Temporal Sequence Hunter | integration, possible extension | **integration; possible meaningful extension** (business-flow atomicity, upgrade-spanning sequences) | F1, F5, F11, F12, F16, F19, D1, D4 |
| 5 | Novel Hypothesis Generator | meaningful extension at most | **integration** (lowered) | F3, F6, F7, F10, F23, D1 (`forge properties`) |
| 6 | Adaptive Search Engine | integration, possibly meaningful extension | **integration, possibly meaningful extension** | D1, D2, D3, F12, F16, F23 |
| 7 | Counterexample and Validation Engine | existing / integration | **existing** (lowered) | D1, D4, F8, F11, F19 |
| 8 | Durable Discovery Memory | meaningful extension (provisional) | **meaningful extension (provisional)** | D1–D3, F4, F8, F10, F23 |

**No capability is rated "potentially novel".** As the apex.md §5 requirement asks, I make no originality claim.

---

## 4. Cross-cutting gaps stated by authors (full texts and official docs only)
1. **Oracles, not search, are the bottleneck for most exploitable bugs.**
   - 80% of studied exploitable bugs were beyond existing tools, because tools rely on simple general oracles or hand-written specifications [F1 p5, Findings 2–3].
   - Five MUB categories admit abstract models "which may serve as oracles for future automated tools" [F1 p10].
   - Even high-effort custom properties would plausibly miss almost 25% of the most important audit findings [F15 p14].
   - Symbolic execution "does not automatically generate postconditions" [D4].
2. **Every "pass" is conditional.**
   - Foundry symbolic `PASS` is bounded, and `Incomplete` is not a proof [D1].
   - hevm issues completeness warnings [D4]. SMTChecker reports "might happen" [D6].
   - Certora has listed sources of unsoundness [D7]. PropertyGPT's BMC depth is 3 [F4 p7].
   - Halmos ignores non-`Panic(1)` reverts [D5].
3. **Multi-transaction and multi-contract behaviour remains hard.**
   - DeFiScope is single-transaction only [F5 p11].
   - Atomicity violations are hard because business flows are implicit [F1 p7, p10].
   - Echidna struggles with sequences that coverage does not reward [F11 p3].
   - Certora checks only the main contract's methods [D7].
   - PoCShift notes cross-contract orchestration [F8 p11].
4. **LLM approaches trade precision for recall and hallucinate.**
   - Hound precision 9.3% [F23 p11]. iAudit cause consistency of about 38% [F6 p1].
   - GPTScan is not path-sensitive [F3 p11]. LLM-SmartAudit is static only [F7 p15].
   - Multi-agent agreement is "not proof" [D1].
5. **Generalisation and contamination.**
   - HKT: generalisation to unseen threats, and no automated knowledge update [F10 p13].
   - Web3Bugs: learning tools were trained on machine-auditable categories [F1 p5]. External validity is limited to recent bugs [F1 p4].
   - ScaBench (README only) rotates datasets to limit training contamination [R27].
6. **Ground truth is expensive and contestable.**
   - MadMax: "no labeled contracts are available"; 1–2 hours per contract for manual inspection [F18 p23].
   - PropertyGPT: no equivalence checker [F4 p13].
   - SmartComment: double labelling, with Cohen's κ 0.85/0.90 [F9 p19].
   - Web3Bugs: difficulty metrics "should only be considered as references" [F1 p4].
7. **A practical, not research, gap.** Unmaintained academic prototypes may not run on current Solidity/EVM (SmartBugs README, README only [R13]).

**Implication for APEX (assessment only).** The gaps that authors state most clearly are automatic oracle and assumption inference (1, and capability 2) and multi-transaction business-flow semantics (3, and capability 4). These are where a measured contribution is most plausible. The stated gaps do **not** point to path exploration (capability 1) or counterexample machinery (capability 7), where maintained tools already document the features APEX lists as "open".

---

## 5. Notable change since the first pass
The official Foundry book (commit a0f150db, 2026-11-23) now documents three things:
1. A symbolic testing MVP with concrete-replay-confirmed, schema-versioned counterexample artifacts that record bounds and assumptions.
2. Fuzz↔symbolic corpus and frontier exchange.
3. `forge properties`, an experimental multi-agent bug-hypothesis workflow with seed-replicated failing tests, root-cause grouping, a quorum and an adversarial verifier.

These directly overlap APEX capabilities 5, 6 and 7, and they are the main reason two ratings were lowered. Because the features are labelled MVP or experimental, they may change. T-151 should re-check them against the book commit it relies on.

---

## 6. What still needs the blocked publisher sites
Reading the following would most change the assessment. The capability each affects is in brackets.
- **Assumption and invariant inference** [2]: SmartInv (S&P 2024), LLM4Vuln, SymGPT, InvCon and Cider (both cited in [F4]), VeriSmart (S&P 2020) and SmarTest (USENIX Sec 2021).
- **DeFi and protocol attack synthesis** [3, 4]: FlashSyn (ICSE 2024), DeFiPoser (S&P 2021), Clockwork Finance, DeFort (ISSTA 2024), DeFiRanger, DeFiTainter, the "flash loans for fun and profit" study (FC 2021), and DeFi-attack SoKs.
- **Sequence-oriented fuzzing and analysis papers** [1, 4, 6]: ItyFuzz (ISSTA 2023; its README claims are unverified), ConFuzzius (EuroS&P 2021), Smartian (ASE 2021), ILF (CCS 2019), Harvey (FSE 2020), sFuzz (ICSE 2020), EF/CF, Sailfish (S&P 2022), SmartPulse, Mau, SmartState, eThor, TxSpector, Horus (FC 2021).
- **Upgradeability** [4]: the USCHunt / proxy-hunting paper (USENIX Sec 2023).
- **Agentic exploit and audit systems** [5, 7, 8]: PoCo (TOSEM 2026, arXiv 2511.02780), A1 (arXiv 2507.05558), "Prompt to Pwn" (arXiv 2508.01371), and the peer-reviewed or arXiv version of Hound (arXiv 2510.09633). Only the author draft in the repo was read.
- **Evaluation infrastructure** [all]: SmartBugs 2.0 (ASE 2023), the Securify CCS'18 paper, Oyente (CCS 2016), the Vandal tech report and KEVM (CSF 2018).
- Optional: the Foundry docs site (getfoundry.sh) to confirm that the rendered book matches the source commit read here.

---

## 7. Access log (negative results)
- **`git ls-remote` returned nothing** for: nevillegrech/ethainter, kushalbabel/Clockwork-Finance, kushalbabel/clockwork, kushalbabel/ClockworkFinance, FlashSyn/FlashSyn, FlashSyn/FlashSyn-Artifact, zhiychen/FlashSyn, secpriv/ethor, LLM4Vuln/LLM4Vuln, Y1ng/LLM4Vuln, ZhangZhuoSJTU/LLM4Vuln, SmartInv/SmartInv, sallywang/SmartInv, SmartInv-repo/SmartInv, SmartState/SmartState, ucsb-seclab/symgpt, shzhshzh/SymGPT, pcy190/SymGPT, christoftorres/SmartPulse, ucsb-seclab/smartpulse, christoftorres/Mau, iaudit/iAudit, ma-wei/iAudit, crytic/slither-mcp, hwang-jian/DeFiTainter, SRI-CSL/solc-verify-examples, and several author-site guesses (mariachris, ZhangZhuoSJTU, sangkilc, SoftSec-KAIST, fuzzland and others).
- **Author or lab site repositories searched with no relevant paper found:** kupl/kupl.github.io, christoftorres/christoftorres.github.io, eth-sri/eth-sri.github.io, VPRLab/VPRLab.github.io, smartbugs/smartbugs.github.io, Demonhero0/Demonhero0.github.io, diaowenrui/diaowenrui.github.io (Android/web papers only), agroce/agroce.github.io (holds Echidna-related PDFs; the `trailofbits/publications` copies were used instead).
- **Found but not used:** SRI-CSL/solidity (solc-verify fork; its README links arXiv only), ethereum/solidity (only `docs/smtchecker.rst` read), ConsenSys/diligence-fuzzing, Certora/gambit, OpenZeppelin/openzeppelin-contracts, a16z/halmos-cheatcodes and smartbugs/smartbugs-wild. Their existence was confirmed only.
