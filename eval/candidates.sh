#!/bin/bash
# Frozen-candidate registry tool. Candidates are identified by commit AND tree SHA in eval/candidates.json (committed and pushed with the
# branch), so their identity survives without remote tags (the remote refuses tag pushes from this environment).
#   eval/candidates.sh verify        - every candidate commit exists, matches its tree/analyzer/harness hashes and is an ancestor of HEAD;
#                                      every recorded result file and corpus manifest is unchanged
#   eval/candidates.sh restore-tags  - recreate missing local annotated tags from the registry (never moves an existing tag)
set -euo pipefail
cd "$(dirname "$0")/.."
node - "$1" <<'JS'
const { execFileSync } = require("node:child_process"); const { readFileSync } = require("node:fs"); const { createHash } = require("node:crypto");
const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const reg = JSON.parse(readFileSync("eval/candidates.json", "utf8")); const mode = process.argv[2]; let bad = 0;
const fail = (m) => { console.error("FAIL " + m); bad++; };
if (mode === "verify") {
  for (const c of reg.candidates) {
    if (tryGit("cat-file", "-t", c.commit) !== "commit") { fail(`${c.name}: commit ${c.commit} not present`); continue; }
    if (git("rev-parse", `${c.commit}^{tree}`) !== c.tree) fail(`${c.name}: tree differs`);
    if (git("rev-parse", `${c.commit}:apps/api/src/analysis`) !== c.analyzerTree) fail(`${c.name}: analyzer tree differs`);
    if (git("rev-parse", `${c.commit}:eval/run-eval.ts`) !== c.harnessBlob) fail(`${c.name}: harness differs`);
    if (tryGit("merge-base", "--is-ancestor", c.commit, "HEAD") === null) fail(`${c.name}: not an ancestor of HEAD`);
    const tag = tryGit("rev-parse", `${c.name}^{commit}`); if (tag !== null && tag !== c.commit) fail(`${c.name}: local tag points at ${tag}`);
    for (const [p, h] of Object.entries(c.scoredResults)) if (sha(p) !== h) fail(`${p} changed`);
    console.log(`candidate ${c.name}: OK (commit ${c.commit}, tree ${c.tree}${tag ? ", local tag OK" : ", no local tag"})`);
  }
  for (const [p, h] of Object.entries({ ...reg.baselineResults, ...Object.fromEntries(Object.entries(reg.otherFrozenResults ?? {}).filter(([k]) => k !== "note")) })) if (sha(p) !== h) fail(`${p} changed`);
  for (const [dir, c] of Object.entries(reg.corpora)) { if (readFileSync(`${dir}/MANIFEST.sha256.sum`, "utf8").trim() !== c.manifestSum) fail(`${dir} manifest sum changed`); if (tryGit("merge-base", "--is-ancestor", c.frozenIn, "HEAD") === null) fail(`${dir}: freeze commit missing`); }
  console.log(bad ? `${bad} problem(s)` : "registry: all candidates, results and corpus manifests verified");
} else if (mode === "restore-tags") {
  for (const c of reg.candidates) {
    const tag = tryGit("rev-parse", `${c.name}^{commit}`);
    if (tag === c.commit) { console.log(`${c.name}: already present`); continue; }
    if (tag !== null) { fail(`${c.name}: an existing tag points at ${tag}; not moved`); continue; }
    if (git("rev-parse", `${c.commit}^{tree}`) !== c.tree) { fail(`${c.name}: tree differs, not tagged`); continue; }
    git("tag", "-a", c.name, c.commit, "-m", `${c.tagMessage}\n\nRestored from eval/candidates.json (registry ${reg.schema}).`); console.log(`${c.name}: restored at ${c.commit}`);
  }
} else { console.error("usage: eval/candidates.sh verify|restore-tags"); process.exit(2); }
process.exit(bad ? 1 : 0);
JS
