# Held-out corpus 4: FROZEN, NOT YET SCORED (future evaluation gate)

**Authoring.** Written by a separate agent. It was told not to read anything under the repository, any earlier corpus, any analyzer
code or any result, and was told nothing about the analyzer. Its brief over-weighted three classes, chosen because corpus 3 showed
them weak (initializer, delegatecall/proxy, selfdestruct). The brief named only the classes, never any failure case.

**Size.** 59 contracts and 79 labels, 12 of them marked `ambiguous` by the author. `tools/` holds the author's generator, label and
compile scripts. They reveal the answers just as `labels.json` does, so they are sealed too.

**Process:**
- **Compiler gate.** All 59 compile with solc 0.8.28. I checked pass/fail only.
- **No exposure.** The author's hand-back gave counts only. The analyzer's author has not opened the contracts, the labels or the tools.
- **Freeze.** Frozen with `MANIFEST.sha256` and committed **before** any analyzer runs on it.

**Rules:**
- No analyzer change may be tuned on it.
- It is scored once, by a candidate registered in `eval/candidates.json` **before** scoring.
- No candidate was scored against it in the cycle that sealed it.
