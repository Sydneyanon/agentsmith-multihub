#!/usr/bin/env python3
"""
Mutation check for the repository-acquisition protections (Task 5.2).

For each entry below it breaks ONE protection in the source (for example "the git object id is not compared"), runs the acquisition
and web test suites, and requires at least one test to fail. A mutant that survives means a protection nobody tests.

Guards that keep the result honest:
  * the baseline must be fully green first, and its test count is recorded;
  * a mutant counts as KILLED only if the full test count still loads and a test actually FAILS; a suite that fails to load is
    reported INVALID, never as a kill.

It edits files IN PLACE and restores them afterwards, so run it in a throw-away git worktree, never in your working checkout:

    git worktree add --detach /tmp/mutwt HEAD && ln -s "$PWD/node_modules" /tmp/mutwt/node_modules
    cd /tmp/mutwt && MUTATION_WORKTREE=1 TEST_DATABASE_URL=postgres://user@127.0.0.1:PORT/postgres python3 scripts/acquisition-mutation-check.py
    # optional: pass substrings of mutant names to run a subset, e.g.  ... check.py "tar:" "plan:"

Needs a loopback Postgres (the integration tests create and drop their own disposable databases). Takes about 50 minutes.
"""
import os, sys
if os.environ.get("MUTATION_WORKTREE") != "1":
    sys.exit("refusing to run: this edits source files in place. Use a throw-away git worktree and set MUTATION_WORKTREE=1 (see the docstring).")
import subprocess, re
A='apps/api/src/acquisition/'
M=[
 # (name, file, find, replace)
 ("tar: header checksum not checked", A+"tar-reader.ts", 'if (octal(block.subarray(148, 156), "header checksum") !== sum)', 'if (false)'),
 ("tar: hard links allowed", A+"tar-reader.ts", 'typeflag !== "0" && typeflag !== "\\0" && typeflag !== "5" && typeflag !== "2")', 'typeflag !== "0" && typeflag !== "\\0" && typeflag !== "5" && typeflag !== "2" && typeflag !== "1" && typeflag !== "3" && typeflag !== "4" && typeflag !== "6" && typeflag !== "7" && typeflag !== "L" && typeflag !== "K" && typeflag !== "S")'),
 ("tar: truncated archive accepted", A+"tar-reader.ts", 'if (this.state !== "end") {', 'if (false) {'),
 ("tar: data after end marker accepted", A+"tar-reader.ts", 'if (data[i] !== 0) throw malformed("data after the end-of-archive marker");', ''),
 ("tar: expanded-size limit not enforced", A+"tar-reader.ts", 'if (this.total > this.limits.maxUncompressedBytes) throw', 'if (false) throw'),
 ("tar: entry-count limit not enforced", A+"tar-reader.ts", 'if (this.entries > this.limits.maxEntries) throw', 'if (false) throw'),
 ("tar: base-256 sizes accepted", A+"tar-reader.ts", 'if ((field[0]! & 0x80) !== 0) throw', 'if (false) throw'),
 ("tar: global pax may set a path", A+"tar-reader.ts", 'if (scope === "global" && (key === "path" || key === "linkpath" || key === "size")) throw', 'if (false) throw'),
 ("tar: symlink may carry data", A+"tar-reader.ts", 'if (size !== 0) throw malformed("a symbolic link entry carries data");', ''),
 ("tar: directory may carry data", A+"tar-reader.ts", 'if (size !== 0) throw malformed("a directory entry carries data");', ''),
 ("tar: zero block followed by data accepted", A+"tar-reader.ts", 'if (this.zeroBlocks !== 0) throw', 'if (false) throw'),
 ("tar: sparse pax keys accepted", A+"tar-reader.ts", 'if (key.startsWith("GNU.sparse") || key.startsWith("SCHILY.")) throw', 'if (false) throw'),
 ("tar: invalid UTF-8 names accepted", A+"tar-reader.ts", 'const strictUtf8 = new TextDecoder("utf-8", { fatal: true });', 'const strictUtf8 = new TextDecoder("utf-8", { fatal: false });'),
 ("gzip: expanded limit not enforced", A+"tar-reader.ts", 'if (stats.uncompressed > limits.maxUncompressedBytes) throw', 'if (false) throw'),
 ("gzip: compressed limit not enforced", A+"tar-reader.ts", 'if (stats.compressed > limits.maxCompressedBytes) throw', 'if (false) throw'),
 ("acquire: git object id not compared", A+"acquire.ts", 'if (gitHasher.finish() !== want.gitSha) throw', 'if (gitHasher.finish() === "never") throw'),
 ("acquire: file size not compared to the tree", A+"acquire.ts", 'if (entry.size !== want.size) throw', 'if (false) throw'),
 ("acquire: missing entries not detected", A+"acquire.ts", 'if (missing.length) throw', 'if (false) throw'),
 ("acquire: extra archive entries accepted", A+"acquire.ts", 'if (!want) throw mismatch(', 'if (!want) return null; if (false) throw mismatch('),
 ("acquire: archive commit not checked", A+"acquire.ts", 'if (comment !== commitSha) throw', 'if (false) throw'),
 ("acquire: archive without a commit accepted", A+"acquire.ts", 'if (globalComment === null) throw', 'if (false) throw'),
 ("acquire: tree id not tied to the commit", A+"acquire.ts", 'if (tree.sha !== commit.treeSha) throw', 'if (false) throw'),
 ("acquire: truncated tree accepted", A+"acquire.ts", 'if (tree.truncated) throw', 'if (false) throw'),
 ("acquire: unrepresentable paths seal silently", A+"acquire.ts", 'if (plan.unrepresentable.length > 0 && onUnrepresentable === "fail")', 'if (false)'),
 ("acquire: sealed manifest not compared", A+"acquire.ts", 'if (seal.manifestSha256 !== manifestHash || seal.fileCount !== rows.length || seal.totalBytes !== storedBytes) {', 'if (false) {'),
 ("acquire: final verification skipped", A+"acquire.ts", 'if (verification.ok !== true) throw new AcquisitionError("verification_failed", "the sealed snapshot does not verify"', 'if (false) throw new AcquisitionError("verification_failed", "the sealed snapshot does not verify"'),
 ("acquire: resumed manifest not compared", A+"acquire.ts", 'if (recorded !== manifestHash) throw', 'if (false) throw'),
 ("acquire: top-level directory not enforced", A+"acquire.ts", 'else if (first !== top) throw', 'else if (false) throw'),
 ("acquire: duplicate paths accepted", A+"acquire.ts", 'if (seen.has(rel)) throw', 'if (false) throw'),
 ("acquire: traversal-shaped paths accepted", A+"acquire.ts", 'if (isTraversalShaped(full)) throw', 'if (false) throw'),
 ("acquire: symlink target not checked against git", A+"acquire.ts", 'if (target.length !== want.size || gitBlobSha1(target) !== want.gitSha) throw', 'if (false) throw'),
 ("acquire: symlink/file type swap accepted", A+"acquire.ts", 'if (want.kind !== "file") throw', 'if (false) throw'),
 ("acquire: symlink type swap accepted (link)", A+"acquire.ts", 'if (want.kind !== "symlink") throw', 'if (false) throw'),
 ("acquire: binary files stored as text", A+"acquire.ts", 'if (content.includes(0)) reason = "binary";', 'if (false) reason = "binary";'),
 ("acquire: non-UTF-8 files stored", A+"acquire.ts", 'catch { reason = "unreadable_encoding"; }', 'catch { /* stored anyway */ }'),
 ("acquire: sealed snapshot re-downloaded", A+"acquire.ts", 'if (existing?.sealed) {', 'if (false) {'),
 ("acquire: sealed snapshot not re-verified", A+"acquire.ts", 'if (verification.ok !== true) throw new AcquisitionError("verification_failed", "the sealed snapshot no longer verifies"', 'if (false) throw new AcquisitionError("verification_failed", "the sealed snapshot no longer verifies"'),
 ("acquire: conflicts merged instead of refused", A+"acquire.ts", 'if (error instanceof ResearchConflictError) throw', 'if (false) throw'),
 ("acquire: timeouts not typed", A+"acquire.ts", 'if (signal.aborted && !(error instanceof AcquisitionError)) {', 'if (false) {'),
 ("plan: manifest-size cap not enforced", A+"plan.ts", 'if (items.length + unrepresentable.length > limits.maxManifestEntries) {', 'if (false) {'),
 ("plan: oversize files not skipped", A+"plan.ts", 'else if (item.size > limits.maxFileBytes) item.plannedSkip = "oversize";', ''),
 ("plan: byte budget not enforced", A+"plan.ts", 'if (used + item.size > limits.maxStoredBytes) item.plannedSkip = "limit_reached";', 'if (false) item.plannedSkip = "limit_reached";'),
 ("plan: exclusions ignored", A+"plan.ts", 'else if (exclude.some((p) => item.path === p || item.path.startsWith(`${p}/`))) item.plannedSkip = "excluded_by_policy";', ''),
 ("plan: duplicate tree paths accepted", A+"plan.ts", 'if (seen.has(entry.path)) throw', 'if (false) throw'),
 ("plan: unknown tree modes accepted", A+"plan.ts", 'else throw new AcquisitionError("unexpected_response", `the tree has an entry of type', 'else kind = "file"; if (false) throw new AcquisitionError("unexpected_response", `the tree has an entry of type'),
 ("paths: NUL accepted", A+"paths.ts", 'if (path.includes("\\u0000")) return "nul";', ''),
 ("paths: tabs and newlines accepted", A+"paths.ts", 'if (/[\\t\\n\\r]/.test(path)) return "tab_or_newline";', ''),
 ("paths: dot segments accepted", A+"paths.ts", 'if (segments.some((s) => s === "" || s === "." || s === "..")) return', 'if (false) return'),
 ("paths: lone surrogates accepted", A+"paths.ts", 'if (Buffer.from(path, "utf8").toString("utf8") !== path) return "invalid_unicode";', ''),
 ("source: redirect hosts not checked", A+"github-source.ts", 'if (!this.allowedOrigins.has(url.origin)) throw refuse(', 'if (false) throw refuse('),
 ("source: credentials in redirect accepted", A+"github-source.ts", 'if (url.username || url.password) throw refuse(', 'if (false) throw refuse('),
 ("source: token sent to every host", A+"github-source.ts", 'if (this.options.token && url.origin === this.apiOrigin) headers.authorization', 'if (this.options.token) headers.authorization'),
 ("source: redirect limit not enforced", A+"github-source.ts", 'for (let hop = 0; hop <= this.limits.maxRedirects; hop += 1) {', 'for (let hop = 0; hop <= 1000; hop += 1) {'),
 ("source: private repositories accepted", A+"github-source.ts", 'if (data.private) throw', 'if (false) throw'),
 ("source: full commit id not verified", A+"github-source.ts", 'if (/^[a-f0-9]{40}$/.test(requested) && data.sha !== requested) throw', 'if (false) throw'),
 ("source: API response size not limited", A+"github-source.ts", 'if (total > this.limits.maxApiResponseBytes) {', 'if (false) {'),
 ("source: declared archive size not checked", A+"github-source.ts", 'if (declared > this.limits.maxCompressedBytes) {', 'if (false) {'),
 ("source: unsafe refs accepted", A+"github-source.ts", 'if (!REF.test(ref) || ref.includes("..")', 'if (false || ref.includes("..")'),
 ("source: test origins allowed outside the test environment", A+"github-source.ts", 'assertTestEnvironment("testOrigins");', ''),
 ("step: lost lease reported as a failure", A+"step.ts", 'if (leaseLost) throw new LeaseLostError', 'if (false) throw new LeaseLostError'),
 ("step: invalid input accepted unvalidated", A+"step.ts", 'if (!parsed.success) throw new AcquisitionError("invalid_reference"', 'if (false) throw new AcquisitionError("invalid_reference"'),
 ("tar: no cleanup on early exit", A+"tar-reader.ts", '    readable.destroy(); gunzip.destroy();\n  }\n}', '  }\n}'),
 ("source: header timer left running (covers the body)", A+"github-source.ts", '      } finally {\n        clearTimeout(timer);\n      }', '      } finally {\n      }'),
 ("source: stalled body never detected", A+"github-source.ts", ', true)), idleMs); });', ', true)), 100000000); });'),
 ("source: long tree paths rejected", A+"github-source.ts", 'max(65_536)', 'max(4096)'),
]
sel=sys.argv[1:]  # optional substrings
survivors=[]; killed=0; skipped=[]; invalid=[]
base=subprocess.run("npx vitest run acquisition 2>&1 | grep -E '^ *(Tests|Test Files) '", shell=True, capture_output=True, text=True).stdout
bm=re.search(r"Tests\s+(\d+) passed \((\d+)\)", base)
if not bm or "failed" in base: print("BASELINE NOT GREEN:", base); sys.exit(2)
BASELINE=int(bm.group(2)); print("baseline:", BASELINE, "tests, all passing")
for name,f,a,b in M:
    if sel and not any(x in name for x in sel): continue
    src=open(f).read()
    if a not in src: skipped.append((name,"pattern not found")); continue
    open(f,'w').write(src.replace(a,b,1))
    try:
        r=subprocess.run("npx vitest run acquisition 2>&1 | grep -E '^ *(Tests|Test Files) '", shell=True, capture_output=True, text=True, env={**os.environ}, timeout=300)
        out=r.stdout.strip().replace("\n"," | ")
        import re
        tests=re.search(r"Tests\s+(?:(\d+) failed \| )?(\d+) passed \((\d+)\)", out)
        files=re.search(r"Test Files\s+(?:(\d+) failed \| )?(\d+) passed", out)
        total=int(tests.group(3)) if tests else 0
        loadfail = False
        if BASELINE is not None and (total < BASELINE or loadfail):
            print(f"INVALID   {name}   (a suite failed to load or tests went missing: {out})"); invalid.append(name); open(f,'w').write(src); continue
        failed=bool(tests and tests.group(1))
    finally:
        open(f,'w').write(src)
    if failed: killed+=1; print(f"KILLED    {name}")
    else: survivors.append(name); print(f"SURVIVED  {name}   [{out}]")
print(f"\nkilled {killed}, survived {len(survivors)}, invalid {len(invalid)}, skipped {len(skipped)}")
for s in skipped: print("SKIPPED", s)
for s in survivors: print("SURVIVOR:", s)
