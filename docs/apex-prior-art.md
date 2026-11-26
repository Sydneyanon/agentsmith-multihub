<!-- T-150 (APEX prior-art and novelty assessment), FIRST PASS, 2026-11-26. Research only: no APEX implementation, no analyzer change. -->
> **Maintainer's note on evidence quality.** Written by a research agent that could open only github.com: arXiv, USENIX, ACM, IEEE and NDSS were unreachable from this environment, so **no paper was read directly**; paper titles and claims are as stated by the tools' own repositories and documentation. I independently confirmed that all 38 cited GitHub repositories exist (`git ls-remote`, 38/38); I did not re-read their contents. The capability ratings are therefore **provisional and conservative**; no capability is rated "potentially novel". A second pass with access to arxiv.org, usenix.org, dl.acm.org, ieeexplore.ieee.org, ndss-symposium.org and getfoundry.sh is required before T-151 relies on these ratings (an environment change only the owner can approve).

# APEX prior-art review: EVM/Solidity vulnerability discovery

Date of review: 2026-11-26. Research only: web pages were read, and no tools were run.

## 0. Read this first: method and an important limitation

**Network constraint.** This session's network allowlist allows `github.com` but not arXiv, IACR ePrint, USENIX, ACM DL, IEEE Xplore, `*.github.io`, the Foundry docs site or `docs.certora.com`. Fetches of `arxiv.org`, `ar5iv.labs.arxiv.org`, `eprint.iacr.org` and `www.usenix.org` failed with DNS errors. As a result:

- **I could not open any paper PDF or abstract page.** Every source marked "verified" below is a page I opened on GitHub: an official or author-provided repository README, or official documentation stored in a GitHub repository (Solidity SMTChecker docs, Certora docs).
- When I give a paper's title, authors or venue, it comes from the citation in that repository. It is **not** from the paper itself. When I describe what a paper claims, that description is also the repository's, unless I say otherwise.
- Web-search result snippets are **not** counted as verified. They appear only in "Sources I could not verify" (section 4).
- A proper novelty assessment needs a follow-up pass with `arxiv.org`, `usenix.org`, `dl.acm.org`, `ieeexplore.ieee.org` and `ndss-symposium.org` allowed, so the full papers can be read. Their "limitations" and "future work" sections are the main source of stated research gaps, and I could only partly reach them.

Classification scale used for each APEX capability, from least to most novel: **existing** < **integration of existing techniques** < **meaningful extension** < **potentially novel**. I chose conservatively. Because of the access limits above, no capability is rated above "meaningful extension".

---

## 1. Landscape by technique family (what was verified)

### 1.1 Static analysis
- **Slither**: a Python framework that converts Solidity/Vyper into the SlithIR intermediate representation and runs about 100 detectors plus printers (call-graph, CFG, vars-and-auth, entry-points). It needs the project to compile. Paper cited in the repo: Feist, Grieco, Groce, "Slither: A Static Analysis Framework For Smart Contracts", WETSEB '19. [R1]
- **Aderyn** (Cyfrin): a Rust Solidity static analyzer with a detector framework, inspired by Slither. **The repo now says it is retired and archived.** [R2]
- **Securify 2.0** (ETH SRI / ChainSecurity): context-sensitive static analysis written in Datalog, with 37 patterns that include TOD (transaction-order dependence) patterns. It supports only flat contracts (no imports). The repo links a CCS'18 PDF, but I could not verify the paper's title. [R3]
- **SmartCheck**: an extensible static analyzer. **Deprecated since 2020**, and it may give wrong results for Solidity 0.6.0 and later. [R4]
- **USCHunt**: Slither augmented with upgradeable-proxy detection (data flow to find where the implementation address is set) and a proxy-pattern taxonomy. A script counts storage-layout and selector collisions with `slither-check-upgradeability`. It is an anonymised artifact for a USENIX Sec '23 submission. [R5]

### 1.2 Symbolic execution and bounded verification
- **Oyente**: archived in 2023. Its toolchain is pinned to old versions (pip2, z3 4.5.0). The repo links a paper PDF but does not give its title. [R6]
- **Mythril** (Consensys): symbolic execution over EVM bytecode with a bounded number of transactions (`-t`). It reports findings by SWC ID. [R7]
- **Manticore**: a symbolic execution framework for binaries and EVM. **Archived and no longer maintained**, with incomplete Istanbul opcode support, and the README warns of state explosion. Cited: Mossberg et al., ASE 2019. [R8]
- **hevm** (now under the `argotorg` org, forked from dapptools by the Ethereum Foundation formal methods team): an EVM built for symbolic execution, equivalence checking, and running Forge tests symbolically. [R9]
- **Halmos** (a16z): symbolic testing that reuses Foundry-style tests. Inputs are symbols covering every value of their type, and it reports counterexamples for assertion violations (`Panic(1)`). The getting-started guide says other reverts are not reported, dynamic arrays need fixed sizes, and `bound()` performs poorly. [R10, R11]
- **teEther**: backward slicing plus symbolic execution that emits concrete exploit transactions (`eth.sendTransaction` calls). Krupp and Rossow, USENIX Security 2018. [R12]
- **VeriSmart / SmarTest**: VeriSmart infers *transaction invariants* that hold under arbitrary interleavings of transactions, and uses them to verify arithmetic safety. SmarTest generates vulnerable transaction sequences with *language-model-guided symbolic execution*. Cited: So et al., S&P 2020 (VeriSmart) and So, Hong, Oh, USENIX Security 2021 (SmarTest). [R13]

### 1.3 Formal verification and specification
- **Solidity SMTChecker**: the CHC engine models the contract as a loop over public functions, so it reasons about an unbounded number of transactions; the BMC engine is deprecated. External calls are treated as **untrusted by default**, so they may re-enter, and counterexamples can show a synthesized reentrant call. A `trusted` mode is available. Counterexamples include a transaction trace. It is sound but incomplete: "might happen" means the solver timed out. [R14]
- **Certora Prover / CVL** docs: invariants are proved by induction (constructor base case, then preservation by each method). "Strong" invariants are also checked around unresolved external calls. The docs list soundness pitfalls: `require`s in preserved blocks, filters, reverting invariants, and invariants that depend on external contracts ("external changes can go unreported"). Loops are unrolled; pessimistic mode is sound and `--optimistic_loop` is unsound. The approximations "can cause real bugs to be overlooked". [R15, R16, R17, R18]
- **KEVM**: an executable formal semantics of the EVM in K. The LLVM backend runs concrete tests and the Haskell backend runs symbolic proofs. It cites a KEVM technical report and a CSF'18 paper; I did not verify the title. [R19]
- **Scribble** (Consensys): a specification/annotation language that instruments contracts for fuzzing or Mythril. Its authors aim to cover about 95% of the properties users want to express, and accept that some properties are hard or impossible to express. [R20]
- **crytic/properties**: 168 reusable properties (ERC20, ERC721, ERC4626, ABDKMath64x64) for Echidna and Medusa. The README warns that HEVM cheatcodes can cause false positives or negatives. [R21]

### 1.4 Fuzzing (stateless and stateful / transaction-sequence)
- **Echidna**: ABI grammar-based fuzzing that uses Slither-extracted information. It generates random *call sequences* to falsify `echidna_` invariants or assertions. Modes include property, assertion, foundry, verification, overflow, optimization and exploration. It saves a coverage-maximizing, replayable corpus and shrinks failing sequences. Cited papers: ISSTA 2020, FC 2020, and ISSTA 2021 (echidna-parade); the README gives no author names for them. [R22]
- **echidna-parade**: runs many Echidna processes in parallel with *swarm testing* (each with a different function blacklist and sequence length) and shares a corpus between them. Groce and Grieco, ISSTA '21. Archived in 2025. [R23]
- **Medusa**: a parallel, coverage-guided, mutational fuzzer based on go-ethereum. It keeps coverage-increasing call sequences in a corpus and mutates them using compile-time and runtime values. [R24]
- **Foundry**: Forge supports "build, test, fuzz"; Anvil can fork mainnet. I did not reach the invariant-testing docs page; see section 4. [R25]
- **ContractFuzzer**: generates calls from the ABI and runs them on an instrumented Geth EVM. The repo identifies the work only as ASE 2018. [R26]
- **sFuzz**: the repo has build and usage notes but no citation or description of its technique. [R27]
- **ItyFuzz**: a hybrid fuzzer for EVM and MoveVM built on LibAFL. Features: symbolic execution, power scheduling, chain forking at any block, reentrancy exploration, flash-loan modelling that assumes unlimited attacker funds, and liquidation simulation. It targets precision loss, overflow, fund stealing and Uniswap pair misuse. The README claims it generates exploits for more than 80% of previous hacks, based on its own backtesting. The paper is linked by DOI only. [R28]
- **ConFuzzius**: a hybrid fuzzer (genetic algorithm plus symbolic execution with constraint solving) with *data-dependency*-aware transaction sequences, maximum individual length 5, and on-chain fuzzing over RPC. EuroS&P 2021. [R29]
- **Smartian**: a grey-box fuzzer that uses static and dynamic data-flow analyses. Bug-triggering inputs are stored as replayable JSON. Choi et al., ASE 2021. [R30]
- **Daedaluzz** (Consensys): a benchmark *generator* of maze contracts. It tests constraint solving and multi-transaction state reachability, and compares Echidna, Forge, Harvey, Hybrid-Echidna and ItyFuzz. The README warns that good benchmark performance may not generalize. [R31]

### 1.5 Learning-guided search
- **ILF**: a neural fuzzing policy trained by *imitating symbolic execution* on thousands of transaction sequences. He et al., CCS 2019. [R32]
- **RLF**: a reinforcement-learning-guided fuzzer for vulnerable transaction sequences, run with a coverage-plus-bugs reward setting. Su et al., ASE '22. [R33]
- **SmarTest**: language-model-guided symbolic execution; see 1.2. [R13]
- **GPTScan**: "Detecting Logic Vulnerabilities in Smart Contracts by Combining GPT with Program Analysis". Sun, Wu, Xue, Liu, Wang, Xu, Xie, Liu, ICSE '24. The README does not describe the method's details. [R34]
- **PropertyGPT**: "LLM-driven Formal Verification of Smart Contracts through Retrieval-Augmented Property Generation". The repo holds benchmarks, human- and LLM-written properties, a `certora_projects` folder, and RQs on CVE detection and zero-days, for an NDSS 2025 submission. [R35]
- **DeFiScope**: "Detecting Various DeFi Price Manipulations with LLM Reasoning". Zhong et al., ASE 2025. It works per transaction (transaction hash plus chain ID) and supports fine-tuned local models. [R36]

### 1.6 Cross-contract, protocol and DeFi analysis
- **SmartReco**: detects *read-only reentrancy* through cross-DApp analysis that combines static analysis (Slither) with dynamic replay and verification (ItyFuzz). Zhang et al., ICSE 2025. The repo calls itself a preliminary version. [R37]
- **ItyFuzz** (flash loans, price manipulation, forking) [R28]; **DeFiScope** (price manipulation) [R36]; **SMTChecker** untrusted-call reentrancy [R14]; **Certora** strong invariants [R15].
- **Web3Bugs** dataset for "Demystifying Exploitable Bugs in Smart Contracts", Zhang, Zhang, Xu, Lin, ICSE 2023. It sorts bugs into out-of-scope (O), those that simple general oracles can detect (L), and those that need **high-level semantic oracles** (S). Stated finding: "a notable proportion of exploitable bugs in smart contracts are functional bugs" that simple oracles cannot detect, and the authors call for automatic semantic oracles. [R38]

### 1.7 Counterexample generation, exploit and PoC synthesis, and validation
- **teEther**: emits exploit transactions. [R12]
- **SmarTest**: emits vulnerable transaction sequences. [R13]
- **ItyFuzz**: generates exploits and forks the chain. [R28]
- **SMTChecker** counterexample traces [R14]; **Halmos** counterexamples [R10, R11]; **Echidna/Medusa** shrunk call sequences [R22, R24].
- **DeFiHackLabs**: a large public set of Foundry reproductions of DeFi incidents. I could see only the landing page, not README details. [R39]
- **PoCo**: "Agentic Proof-of-Concept Exploit Generation for Smart Contracts". Andersson, Bobadilla, Hobbelhagen, Monperrus, ACM TOSEM 2026 (just accepted). The repo holds only artifacts; the tool is available on request. [R40]
- **AEG-PoC**: a dataset of vulnerable contracts and `.t.sol` PoCs for "Prompt to Pwn: Automated Exploit Generation for Smart Contracts". Xiao, Li, Wang, Chen, arXiv:2508.01371, 2025. [R41]

### 1.8 Evaluation infrastructure
- **SmartBugs 2.0**: a framework with a uniform interface over 28 tools, including LLM-based ones. It is parallel and restartable, and outputs SARIF. It warns that unmaintained academic prototypes may not work with current Solidity/EVM. Cited: di Angelo, Durieux, Ferreira, Salzer, ASE 2023. [R42]

**A recurring observation from the verified sources:** many classic research tools are archived, deprecated or pinned to old Solidity (Oyente, Manticore, SmartCheck, Aderyn, echidna-parade, ContractFuzzer, RLF, ConFuzzius). This is a practical gap, as the SmartBugs README also notes [R42]. It is not a research gap.

---

## 2. Mapping onto the eight APEX capabilities

### (1) Execution Path Explorer
**Paths across functions, modifiers, helpers, contracts and transaction sequences.**

- **Relevant techniques and systems**
  - Inter-procedural IR and call graphs: Slither [R1].
  - Symbolic execution over bounded transaction counts: Mythril [R7], Manticore [R8], hevm [R9], Halmos [R10].
  - Unbounded-transaction model checking: the SMTChecker CHC engine [R14].
  - Stateful sequence fuzzing: Echidna [R22], Medusa [R24], Smartian [R30], ConFuzzius [R29], ItyFuzz [R28].
  - Cross-contract and cross-DApp analysis: SmartReco [R37]; the SMTChecker untrusted-call model [R14].
- **What already exists**
  - Path and sequence exploration at bytecode and source level is mature.
  - Tools exist for each of: single-function symbolic proofs, multi-transaction falsification, and unbounded inductive reasoning.
  - Forked-chain exploration of deployed multi-contract systems [R28].
- **Limitations and gaps**
  - Manticore's README notes state explosion [R8].
  - Bounds: transactions [R7], loops [R17, R18], fixed-size dynamic arrays [R11].
  - Benchmarks single out multi-transaction state reachability and complex constraints as the hard cases [R31].
  - Coverage of *modifiers and helpers* is implicit in all IR- or bytecode-level tools; no verified source treats it as a separate problem.
- **Classification: existing / integration of existing techniques.** Exploring paths across these units is what existing tools do. Combining static, symbolic and fuzzing exploration in one system is integration; Echidna already uses Slither, and SmartReco and ItyFuzz are already hybrids.
- **Evidence needed for novelty:** measured reachability or coverage gains over Echidna, Medusa, ItyFuzz, Halmos and the SMTChecker on standard benchmarks (Daedaluzz [R31], SmartBugs datasets [R42], Web3Bugs [R38]), at equal time budgets, with ablations.

### (2) Assumption Breaker
**Extract explicit and implicit security assumptions and try to violate them.**

- **Relevant techniques and systems**
  - Explicit specifications: Scribble [R20], CVL invariants [R15], `echidna_` properties [R22], crytic/properties [R21], SMTChecker asserts with `require` treated as assumptions [R14].
  - Automatic invariant inference: VeriSmart's transaction invariants [R13].
  - LLM property generation: PropertyGPT [R35].
  - LLM plus program-analysis confirmation: GPTScan [R34].
- **What already exists**
  - Turning *written-down* properties into checks, then falsifying or proving them.
  - Inferring some invariants automatically (arithmetic safety in VeriSmart).
  - LLM-generated properties checked with a prover (PropertyGPT, as described by its repo).
- **Limitations and gaps**
  - Web3Bugs states that many exploitable bugs are functional and need *semantic oracles*, and calls for automating them [R38]. That is the strongest verified statement of the gap this capability targets.
  - The Certora docs list how *assumptions themselves* (preserved-block `require`s, filters, `requireInvariant`) can make proofs unsound [R15].
  - Scribble's authors accept that some properties are hard to express [R20].
  - Implicit assumptions about external components (oracles, tokens, callers) are where the verified tools are weakest. Certora warns about invariants that depend on external contracts [R15], and the SMTChecker's trusted/untrusted switch is all-or-nothing per call type [R14].
- **Classification: integration of existing techniques, possibly a meaningful extension.** Extracting assumptions with LLMs and checking them with fuzzers or provers exists (PropertyGPT, GPTScan). APEX could count as a meaningful extension only if it systematically extracts *implicit* assumptions, especially about the environment and external dependencies, and *also audits the analysis's own assumptions*, which [R15] shows to be a real failure mode.
- **Evidence needed for novelty**
  - On Web3Bugs category S bugs [R38] and PropertyGPT's benchmarks [R35], show that APEX's extracted assumptions catch bugs that PropertyGPT, GPTScan and the reusable property suites miss.
  - Report how precise the extracted assumptions are, and how many of the violated assumptions correspond to real bugs.

### (3) Protocol Interaction Explorer
**Contracts, integrations, oracles, tokens, lending, vaults, bridges and external dependencies.**

- **Relevant techniques and systems**
  - ItyFuzz: chain forking, flash-loan and liquidity-pool modelling, price-manipulation findings [R28].
  - DeFiScope: price-manipulation detection with LLM reasoning [R36].
  - SmartReco: cross-DApp read-only reentrancy [R37].
  - Vault and token property suites: ERC4626 and ERC20 properties [R21].
  - Proxy and upgradeability analysis: USCHunt [R5].
  - Adversarial external calls: SMTChecker [R14]; strong invariants in Certora [R15].
- **What already exists**
  - Fuzzing against real forked state with attacker capital modelled.
  - Detecting price manipulation per transaction.
  - Cross-application reentrancy detection.
- **Limitations and gaps**
  - ItyFuzz models flash loans by assuming unlimited attacker funds [R28], which over-approximates real attacks.
  - DeFiScope analyses given transactions, so it detects rather than synthesizes [R36].
  - SmartReco is preliminary [R37].
  - Certora checks preservation only for the main contract's methods [R15].
  - I found **no verified source** that models bridges or arbitrary oracle semantics in general.
  - I could not verify the flash-loan attack-synthesis literature (FlashSyn, DeFiPoser, the "flash loans for fun and profit" study); see section 4. That literature is directly relevant and must be read before any claim is made.
- **Classification: integration of existing techniques.** Covering bridges and oracles in one model of protocol interactions *could* be a meaningful extension, but the unverified DeFi synthesis literature may already cover much of it.
- **Evidence needed for novelty**
  - Reproduce incidents from DeFiHackLabs [R39] and the FlashSyn and DeFiPoser benchmarks, once they are verified.
  - Report incidents that ItyFuzz and FlashSyn cannot synthesize but APEX can.
  - Report which kinds of protocol interaction are actually modelled.

### (4) Temporal Sequence Hunter
**Unusual sequences of valid operations, state transitions, upgrades, partial operations and transaction ordering.**

- **Relevant techniques and systems**
  - Sequence fuzzers: Echidna [R22], Medusa [R24], ConFuzzius with data dependency [R29], Smartian [R30], RLF [R33], ILF [R32].
  - Sequence-oriented symbolic execution: SmarTest [R13].
  - Arbitrary interleavings: VeriSmart transaction invariants [R13]; SMTChecker CHC unbounded transactions [R14].
  - Transaction-order dependence patterns: Securify2 TOD* [R3].
  - Upgrade-related structure: USCHunt [R5].
  - Breadth: swarm testing of sequence lengths and function subsets in echidna-parade [R23].
- **What already exists**
  - Generating and minimizing multi-transaction sequences to falsify invariants.
  - Ordering sequences by data dependency.
  - Choosing sequences with RL or imitation learning.
  - Unbounded-transaction proofs.
- **Limitations and gaps**
  - The default maximum sequence length is small in ConFuzzius (5) [R29].
  - Benchmarks identify deep multi-transaction state as hard [R31].
  - USCHunt *classifies* proxies and counts collisions but does not explore *sequences across an upgrade* [R5].
  - Partial operations (multi-step flows abandoned halfway) and reordering of a mempool or block were not explicit targets in any source I verified, apart from TOD patterns [R3].
- **Classification: integration of existing techniques, with a possible meaningful extension for upgrade-spanning and partially completed multi-step sequences.** That extension depends on checking the unverified upgrade-security literature first; see section 4.
- **Evidence needed for novelty**
  - Findings that require (a) an upgrade in the middle of a sequence, or (b) abandoned partial flows.
  - Show that Echidna, Medusa and ItyFuzz, with comparable handlers, do not find them within the same budget.

### (5) Novel Hypothesis Generator
**Original, evidence-backed hypotheses beyond fixed templates.**

- **Relevant techniques and systems**
  - LLM-assisted auditing: GPTScan [R34]; PropertyGPT, with properties retrieved from existing human-written ones [R35]; DeFiScope [R36].
  - LM-guided search: SmarTest [R13].
  - Template detectors: about 100 Slither detectors [R1], 37 Securify2 patterns [R3], Mythril SWC modules [R7].
- **What already exists**
  - Template and detector systems are dominant.
  - LLM systems generate candidate findings or properties and then confirm them statically or formally.
- **Limitations and gaps**
  - Web3Bugs' call for semantic oracles [R38] supports the need.
  - I could not read the GPTScan or PropertyGPT papers to confirm how *template-bound* their generation is. PropertyGPT's approach, retrieving and adapting existing properties, as indicated by its title [R35], suggests it is anchored to known properties. That is my inference, not a stated limitation.
- **Classification: meaningful extension, at most.** "Original hypotheses beyond templates" is a claim that is hard to evaluate and easy to overstate. It should not be called novel without the evidence below.
- **Evidence needed for novelty**
  - A blinded evaluation showing that hypotheses which led to confirmed findings fall outside the detector and template catalogs (Slither, Securify2, SWC) and outside the retrieval corpus.
  - Precision: the share of hypotheses confirmed by the validation engine.
  - Comparison against GPTScan and PropertyGPT on the same targets.
  - Ideally, previously unknown bugs that the maintainers confirmed.

### (6) Adaptive Search Engine
**Prioritise promising or unexplored paths by evidence, coverage gaps, novelty and measured discovery value.**

- **Relevant techniques and systems**
  - Coverage-guided corpora: Echidna [R22], Medusa [R24], Smartian [R30].
  - Power scheduling: ItyFuzz [R28].
  - Hybrid switching between fuzzing and symbolic execution: ConFuzzius [R29], ItyFuzz [R28].
  - Learned policies: ILF [R32], RLF with a coverage-plus-bugs reward [R33], SmarTest's LM guidance [R13].
  - Diversity across a portfolio of configurations: echidna-parade swarm [R23].
- **What already exists**
  - Prioritisation driven by coverage and bug rewards, inside a single engine.
- **Limitations and gaps**
  - ILF needs costly training data from tens of thousands of contracts [R32].
  - Daedaluzz warns that tuned performance may not generalize [R31].
  - I found no verified system that allocates budget *across heterogeneous engines* (static, symbolic, fuzzing, LLM) by measured discovery value. I may simply have missed it, given the access limits.
- **Classification: integration of existing techniques, possibly a meaningful extension** if it schedules across engines by measured discovery value.
- **Evidence needed for novelty**
  - An ablation against fixed or round-robin portfolios and against single engines, at equal compute.
  - Report time to first finding, unique findings and coverage on Daedaluzz [R31] and on real protocols.

### (7) Counterexample and Validation Engine
**Refute hypotheses, produce reproducible counterexamples and invariant violations.**

- **Relevant techniques and systems**
  - Exploit and sequence generation: teEther [R12], SmarTest [R13], ItyFuzz [R28].
  - Prover counterexamples: SMTChecker traces [R14], Halmos [R10, R11], Certora [R15].
  - Shrunk, replayable sequences: Echidna and Medusa corpora [R22, R24]; Smartian JSON [R30].
  - Foundry PoCs: DeFiHackLabs [R39], PoCo [R40], AEG-PoC [R41].
  - Static warnings confirmed by dynamic replay: SmartReco [R37].
- **What already exists:** producing concrete, replayable counterexamples is standard.
- **Limitations and gaps**
  - SMTChecker counterexample paths are not unique and depend on the solver and version; "might happen" results are possible [R14].
  - Halmos reports only assertion violations [R11].
  - Optimistic loops, filters and assumptions can make "verified" results meaningless [R15, R18].
  - HEVM cheatcodes can cause false positives and negatives in property testing [R21].
- **Classification: existing / integration of existing techniques.**
  - Validating each hypothesis *independently* across engines (fuzz, symbolic and fork replay) is integration.
  - Recording what each "no counterexample found" result is conditional on (bounds, assumptions) would be good engineering informed by [R15, R18]. It is not a research novelty.
- **Evidence needed for novelty:** report the false-positive reduction from cross-engine validation, against single-engine validation, on labelled datasets.

### (8) Durable Discovery Memory
**Explored paths, strategies, false positives, and confirmed and missed findings.**

- **Relevant techniques and systems**
  - Persistent corpora: Echidna `corpusDir` with `covered.txt` [R22], Medusa corpus [R24], echidna-parade shared corpus with stop and resume [R23].
  - Restartable campaigns: SmartBugs [R42].
  - A retrieval memory of properties: PropertyGPT, per its title and repo contents [R35].
  - Curated corpora of known bugs and PoCs: Web3Bugs [R38], DeFiHackLabs [R39], Proof-of-Patch and PoCo artifacts [R40].
- **What already exists:** memory of inputs and coverage within or across campaigns, and static datasets of known bugs.
- **Gaps:** I found no verified source describing persistent, cross-target memory of *strategies, false positives and missed findings* that feeds back into search. Absence from the sources I could reach is weak evidence, especially since agent-based and LLM auditing work published in 2025–2026 could not be read.
- **Classification: meaningful extension, provisionally.** Downgrade to "integration" if the unread LLM-agent auditing literature already includes such memory.
- **Evidence needed for novelty**
  - A longitudinal evaluation over a sequence of audit targets: does memory improve time to finding and lower the false-positive rate on later targets?
  - Ablations with memory turned off.
  - Controls for data leakage: memory of known incidents must not trivially "rediscover" them.

---

## 3. Overall assessment
- Most of APEX is **an integration of existing techniques**: static, symbolic and fuzzing exploration, sequence fuzzing, PoC and counterexample generation, and corpus persistence.
- The most defensible candidates for **meaningful extension** are:
  - (2) implicit and environmental assumption extraction combined with auditing the analysis's own assumptions;
  - (6) cross-engine scheduling by measured discovery value;
  - (8) durable cross-target memory of strategies and false positives;
  - (4), conditionally, upgrade-spanning and partial-flow sequences.
- **None is rated "potentially novel".** Key literature (flash-loan synthesis, DeFi attack SoKs, LLM agent auditing, Harvey, the full GPTScan, PropertyGPT and SmartInv papers) could not be read in this session.
- The single strongest verified motivation for APEX is the Web3Bugs finding that many exploitable bugs need high-level semantic oracles [R38].

---

## 4. Sources I could not verify

Each item below was **seen only as a web-search snippet or known from memory**. I did not open its primary page, so none of it is cited above as evidence. A follow-up pass should read each one once `arxiv.org`, `usenix.org`, `dl.acm.org`, `ieeexplore.ieee.org`, `ndss-symposium.org` and `getfoundry.sh` are reachable.

**Venue or title details not confirmed**
- Slither arXiv 1908.09878 (venue WETSEB'19 is confirmed only through the repo [R1]).
- Oyente paper: Luu et al., "Making Smart Contracts Smarter", CCS 2016 (from memory; the repo links a PDF without a title).
- Securify CCS'18 paper: title and authors not verified.
- ContractFuzzer, ASE 2018: title and authors not verified.
- sFuzz, ICSE 2020: not verified.
- ConFuzzius paper, arXiv 2005.12156: the title and author list are not given in the repo.
- ItyFuzz paper, DOI 10.1145/3597926.3598059: title, authors and venue not verified.
- KEVM CSF'18 paper: title not verified.

**Not opened at all**
- Harvey greybox fuzzer, arXiv 1905.06944.
- FlashSyn: Chen, Beillahi, Long, ICSE 2024, arXiv 2206.10708. Only seen in a snippet.
- Flash-loan attack study, "Attacking the DeFi Ecosystem with Flash Loans for Fun and Profit" (FC 2021), and DeFiPoser (S&P 2021): from memory.
- DeFort (ISSTA 2024), DeFiTainter, DeFiRanger: only seen in snippets.
- SmartInv: Wang, Pei, Yang, S&P 2024, arXiv 2411.09217. Only seen in a snippet.
- SliSE (FSE 2024, arXiv 2403.11254), Clairvoyance (ASE 2020), xFuzz (arXiv 2111.12423): snippets.
- A1 agentic exploit generation, arXiv 2507.05558: snippet.
- The paper content of "Prompt to Pwn", arXiv 2508.01371, including any statement about cross-contract difficulty. Only the repo was verified [R41].
- PropertyGPT and GPTScan quantitative results: snippets only. Only the repos were verified [R34, R35].
- The Foundry invariant-testing documentation (getfoundry.sh): the GitHub path I tried returned 404. Handler, `targetContract` and `fail_on_revert` behaviour is not verified here.
- Proxy Hunting (USENIX Sec '23) paper text: title and authors seen only in a snippet. Only the anonymised repo was verified [R5].
- "SoK: Decentralized Finance (DeFi) Attacks" and other SoKs: not opened.

---

## 5. References (verified: opened and read in this session)

Each entry gives the URL and a one-line note on what I verified there. All were opened on 2026-11-26.

| # | Source | URL | What I verified |
|---|---|---|---|
| R1 | Slither repository (Trail of Bits / crytic) | https://github.com/crytic/slither | SlithIR, about 100 detectors and 10 printers; cites Feist, Grieco, Groce, WETSEB '19; compilation requirement. |
| R2 | Aderyn repository (Cyfrin) | https://github.com/Cyfrin/aderyn | Rust Solidity static analyzer; retired and archived, no support. |
| R3 | Securify 2.0 repository (ETH SRI) | https://github.com/eth-sri/securify2 | Datalog context-sensitive analysis; 37 patterns including TOD; flat contracts only. |
| R4 | SmartCheck repository | https://github.com/smartdec/smartcheck | Extensible static analyzer; deprecated since 2020; problems with Solidity 0.6.0 and later. |
| R5 | USCHunt repository (anonymised USENIX'23 artifact) | https://github.com/USCHunt-Anon/USCHunt | Slither-based proxy detection via dataflow, proxy-pattern taxonomy, collision counting script. |
| R6 | Oyente repository | https://github.com/enzymefinance/oyente | Archived 2023; old pinned toolchain; paper PDF linked without title. |
| R7 | Mythril repository (Consensys) | https://github.com/Consensys/mythril | Symbolic execution over EVM bytecode; `-t` transaction bound; SWC-ID reporting. |
| R8 | Manticore repository | https://github.com/trailofbits/manticore | Symbolic execution for EVM and binaries; archived; incomplete Istanbul support; state explosion; cites Mossberg et al., ASE 2019. |
| R9 | hevm repository | https://github.com/ethereum/hevm | Symbolic execution, equivalence checking, symbolic Forge tests; EF formal methods fork of dapptools. |
| R10 | Halmos repository (a16z) | https://github.com/a16z/halmos | Symbolic testing for EVM that reuses Foundry tests. |
| R11 | Halmos getting-started doc | https://github.com/a16z/halmos/blob/main/docs/getting-started.md | Symbolic inputs; counterexamples only for assertion failures; fixed-size dynamic arrays; `bound()` caveat. |
| R12 | teEther repository | https://github.com/nescio007/teether | Slicing plus symbolic execution producing exploit transactions; Krupp and Rossow, USENIX Security 2018. |
| R13 | VeriSmart / SmarTest repository (KUPL) | https://github.com/kupl/VeriSmart-public | Transaction-invariant inference; LM-guided symbolic execution for vulnerable sequences; S&P 2020 and USENIX Sec 2021 citations. |
| R14 | Solidity SMTChecker docs | https://github.com/ethereum/solidity/blob/develop/docs/smtchecker.rst | CHC and BMC engines, targets, counterexample traces, trusted/untrusted external calls, sound-but-incomplete caveats. |
| R15 | Certora docs: CVL invariants | https://github.com/Certora/Documentation/blob/master/docs/cvl/invariants.md | Inductive invariants, strong invariants around external calls, listed soundness pitfalls. |
| R16 | Certora Documentation repository | https://github.com/Certora/Documentation | Official Prover docs source (User Guide, Reference Manual including CVL). |
| R17 | Certora docs: approximations index | https://github.com/Certora/Documentation/blob/master/docs/prover/approx/index.md | Approximations may underapproximate and "can cause real bugs to be overlooked". |
| R18 | Certora docs: loops | https://github.com/Certora/Documentation/blob/master/docs/prover/approx/loops.md | Loop unrolling; pessimistic mode sound, optimistic mode unsound. |
| R19 | KEVM repository (Runtime Verification) | https://github.com/runtimeverification/evm-semantics | K semantics of the EVM; LLVM (concrete) and Haskell (symbolic) backends; proof tests. |
| R20 | Scribble repository (Consensys) | https://github.com/Consensys/scribble | Spec and instrumentation for fuzzing and Mythril; aims for about 95% of desired properties. |
| R21 | crytic/properties repository | https://github.com/crytic/properties | 168 properties (ERC20, ERC721, ERC4626, ABDK) for Echidna and Medusa; cheatcode false-positive/negative caveat. |
| R22 | Echidna repository | https://github.com/crytic/echidna | Property and assertion sequence fuzzing, modes, corpus, shrinking; ISSTA'20, FC'20 and ISSTA'21 citations (no authors listed). |
| R23 | echidna-parade repository | https://github.com/crytic/echidna-parade | Swarm-testing multicore Echidna with shared corpus; Groce and Grieco, ISSTA '21; archived 2025. |
| R24 | Medusa repository | https://github.com/crytic/medusa | Parallel, coverage-guided, mutational call-sequence fuzzing based on go-ethereum. |
| R25 | Foundry repository | https://github.com/foundry-rs/foundry | Forge (build, test, fuzz) and Anvil mainnet forking; invariant docs not on this page. |
| R26 | ContractFuzzer repository | https://github.com/gongbell/ContractFuzzer | ABI-based call generation, instrumented Geth; "ASE 2018" only. |
| R27 | sFuzz repository | https://github.com/duytai/sFuzz | Build and usage only; no citation or technique description. |
| R28 | ItyFuzz repository and README | https://github.com/fuzzland/ityfuzz | Hybrid LibAFL fuzzer; power scheduling; chain forking; flash-loan assumption; self-reported backtesting claim; DOI-only paper link. |
| R29 | ConFuzzius repository and README | https://github.com/christoftorres/ConFuzzius | GA plus symbolic hybrid, data-dependency sequences, maximum length 5; EuroS&P 2021; links arXiv 2005.12156. |
| R30 | Smartian repository | https://github.com/SoftSec-KAIST/Smartian | Static and dynamic data-flow guided fuzzing; Choi et al., ASE 2021. |
| R31 | Daedaluzz repository (Consensys) | https://github.com/Consensys/daedaluzz | Maze benchmark generator; fuzzers compared; generalisation caveat. |
| R32 | ILF repository (ETH SRI) | https://github.com/eth-sri/ilf | Imitation-learned fuzzing policy from symbolic execution; He et al., CCS'19; training-cost caveat. |
| R33 | RLF repository | https://github.com/Demonhero0/rlf | RL-guided sequence fuzzing (cov+bugs reward setting); Su et al., ASE '22. |
| R34 | GPTScan repository | https://github.com/VPRLab/GPTScan | Title, authors and ICSE'24 citation; GPT-based logic vulnerability detection. |
| R35 | PropertyGPT repository | https://github.com/Pr0pertyGPT/PropertyGPT | Retrieval-augmented property generation title; benchmarks, Certora projects, RQs; NDSS 2025 submission. |
| R36 | DeFiScope repository | https://github.com/AIS2Lab/DeFiScope | LLM price-manipulation detection per transaction; Zhong et al., ASE 2025. |
| R37 | SmartReco repository | https://github.com/zzz-sysu/smartReco | Read-only reentrancy, cross-DApp static plus ItyFuzz-based dynamic verification; Zhang et al., ICSE 2025; preliminary version. |
| R38 | Web3Bugs repository | https://github.com/ZhangZhuoSJTU/Web3Bugs | O/L/S taxonomy; finding that many exploitable bugs need semantic oracles; Zhang et al., ICSE 2023. |
| R39 | DeFiHackLabs repository | https://github.com/SunWeb3Sec/DeFiHackLabs | "Reproduce DeFi hacked incidents using Foundry"; Foundry layout (README body not rendered). |
| R40 | PoCo-public repository (KTH) | https://github.com/ASSERT-KTH/PoCo-public | Agentic PoC generation; Andersson et al., ACM TOSEM 2026; artifacts only, tool on request. |
| R41 | AEG-PoC repository | https://github.com/Crimson798/AEG-PoC | Vulnerable contracts plus `.t.sol` PoCs for "Prompt to Pwn" (arXiv 2508.01371). |
| R42 | SmartBugs repository | https://github.com/smartbugs/smartbugs | 28-tool execution framework; di Angelo et al., ASE 2023; warning about unmaintained prototypes. |

Total: **42 verified sources**, all hosted on github.com: repository READMEs, or official docs kept in GitHub repositories.
