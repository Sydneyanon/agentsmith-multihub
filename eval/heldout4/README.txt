Held-out Solidity evaluation corpus (heldout4)
===============================================

Authoring
---------
All contracts were written from scratch for this corpus, from general knowledge of
real-world Solidity patterns and incidents (re-entrant withdrawals and token hooks,
unguarded or re-openable initialisers, uninitialised UUPS / clone / library
implementations in the style of the Parity and UUPS-implementation incidents,
beacon and transparent proxy admin paths, proxy storage collisions, user-controlled
delegatecall targets, msg.value reuse in delegatecall batches, tx.origin
authorisation, ignored call/send/transfer results). No external corpus, analyzer
code or evaluation results were consulted, and no network was used.

- contracts/  59 self-contained .sol files, pragma solidity ^0.8.20, no imports
  (interfaces, Initializable/Ownable/UUPS/ERC-1967 bases are defined inline).
- Roughly half of the vulnerable cases have a twin file (same contract names) that
  differs only in the fix. Twins share a `pair` id in labels.json.
- Initializer, delegatecall/proxy and selfdestruct cases are over-weighted
  (proxies with fallbacks, logic contracts with selfdestruct, initialisers reached
  through inheritance, upgradeTo/upgradeToAndCall with and without auth, beacon and
  UUPS patterns, clone implementations).
- tools/gen_init.py and tools/gen_dc.py generate the I*, D* and S* files (R*, A*, T*,
  U* were written directly); tools/labels.py builds labels.json and verifies every
  `line` against the final file text (needle lookup inside the named contract,
  uniqueness checks, every file labelled, each pair = one vulnerable + one benign
  label in two different files); tools/compile.js compile-checks every file.
  NOTE: tools/ and labels.json contain the answers.

Label schema (labels.json: JSON array)
--------------------------------------
  file        "contracts/<name>.sol"
  contract    contract in which the function is declared
  function    function name; "fallback" / "receive" for those
  class       reentrancy | access-control | initializer | delegatecall |
              selfdestruct | tx-origin | unchecked-call
  vulnerable  boolean
  line        1-based line of the key statement (for reentrancy: the external call;
              for missing-modifier cases: the function signature; for tx.origin
              cases reached through a modifier: the tx.origin check)
  pair        twin id string shared by a vulnerable/benign twin, or null
  ambiguous   true when reasonable experts could disagree (reason in note)
  note        one sentence
Proxy admin / upgrade functions (upgradeTo, _authorizeUpgrade) are labelled under
"initializer"; proxy fallbacks under "delegatecall". Reentrancy labels under 0.8
checked arithmetic are vulnerable only where a re-entrant exploit actually succeeds
(a pattern whose unwind underflows and reverts is labelled benign, ambiguous).

Counts (79 labels, 59 files, 28 twin pairs)
-------------------------------------------
  class            vulnerable  benign  ambiguous
  reentrancy            4         3        2
  access-control        6         8        0
  initializer          11        10        3
  delegatecall          6        11        2
  selfdestruct          4         5        3
  tx-origin             3         2        1
  unchecked-call        4         2        1
  total                38        41       12

Compilation
-----------
All 59 files compile individually without errors with solc-js 0.8.28
(0.8.28+commit.7893614a.Emscripten.clang), via tools/compile.js. selfdestruct
produces the expected deprecation warnings only.
