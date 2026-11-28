# Corpus 5 selection brief (for the independent selector)

**Status: brief approved for preparation (T-180, 2026-11-26). Selection and acquisition are NOT approved (A22). Scoring is NOT
approved (A23).** Nothing in this directory names a repository yet.

You are the **selector**. You are not the author of the analyzer being tested, and you must not read its code, results, corpora 1–4 or
documentation. You receive only this brief and the two schemas in `schema/`. Your output is two files:
- `selection.json`: the repositories and pinned commits to analyse. The analyzer side will see it.
- `ground-truth.json`: the answers. The analyzer side must not see it until scoring. Hand it back sealed (see PROCESS.md).

## What to select
20 to 30 entries. An entry is one public Solidity repository at one commit, with the in-scope paths of a published security review.

**Sources:** public audit-contest or audit reports that list findings with locations and that link to a fix: contest findings
repositories, public audit reports from reputable firms, or public post-mortems with a fix commit.

**Inclusion rules (all required):**
1. The repository is public and the commit is reachable (record the 40-hex SHA and the tree SHA).
2. Solidity ≥ 0.6. In-scope code is at most about 15,000 lines.
3. Each finding you map is High or Medium severity in the source report, or a confirmed exploit.
4. **Recency for blinding:** prefer reports **published after 2026-06-30**. Record the publication date. If you must use an earlier
   report, mark `prior_knowledge_risk: true`.
5. Not a fork or copy of a repository already in the corpus. Note shared bases (OpenZeppelin and similar) in `code_family`.
6. Never use the repositories `crytic/not-so-smart-contracts`, or anything from the analyzer's own repository.

**Class mix:**
- At least 12 entries with findings in the engine's claimed classes: reentrancy, access-control, initializer, delegatecall/proxy,
  selfdestruct, unchecked-call, tx-origin.
- At least 8 entries whose findings are only in **other** classes (oracle/price manipulation, accounting/rounding, business logic,
  signature replay, DoS and others), so that misses are measured honestly.

**Controls (at least one third of entries):**
- for some vulnerable entries, the same repository at the **fix commit** (`kind: "post_fix_control"`);
- or a repository whose public review found **no** High or Medium issue (`kind: "clean_control"`).

## How to map ground truth
For each finding:
- the report URL and finding id;
- severity;
- its class (one of the claimed classes, or `other:<short description>`);
- every location, as file path, contract and function (line range where the report gives one);
- the fix commit and the fix diff's touched functions as confirmation.

If you cannot map a finding to a function, keep it with `mappable: false`; never drop it.

For a post-fix control, list the findings that the fix addressed, as `fixed_findings`. These locations must **not** be reported as
vulnerable at the fix commit.

## What you must not do
- Do not run any analyzer or tool on the code.
- Do not contact projects, report authors or any bounty platform.
- Do not fetch anything except public pages and public repositories (read-only).
- Do not change a file once you have handed it back. Corrections go in a separate, dated errata file.

## Hand-back
- `selection.json` and `ground-truth.json`, each valid against its schema.
- A short `SELECTION-NOTES.md`: how candidates were found, how many were considered and rejected and why, and time spent.
- To the analyzer side, report **counts only**: entries, findings, classes and controls.
