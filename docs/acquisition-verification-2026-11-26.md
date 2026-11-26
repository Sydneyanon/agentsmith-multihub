# 5.2 acquisition: local verification record and live-path validation plan (2026-11-26)

## 1. What was verified locally today (development evidence)

| Check | Method | Result |
|---|---|---|
| Integration suites | `acquisition`, `structural-*`, `research-state-*` integration tests on disposable Postgres | **111/111 passed** (6 files) |
| Exact commit pinning | the clone-mode driver refuses unless the clone's HEAD equals the pinned SHA | a wrong pin (`000…001`) **refused**, rc=1, "clone HEAD 020dbdb… is not the pinned commit" |
| Snapshot integrity | the acquisition path verifies every file against its git object id before sealing; the database recomputes the manifest | sealed, `completeness: complete`, 47 files |
| Reproducibility across independent runs | two **separate clones** of `crytic/not-so-smart-contracts` at `020dbdbde3e0c2e8de5f3944e7455e438b0995d5`, each acquired into its own throwaway database | identical manifest `b0d4fb23c8487a77a609f1f60f1ef7da294ede37adcd8457b9b6a36575b838f4`, which also matches the earlier session's record; identical lead count (34); identical **dossier content hash** `b9fe52e4…37dd1`. The raw dossier files differ only in run ids and timestamps, which the content hash excludes by design |
| Failure and retry handling | integration tests: a crash while storing blobs leaves an unsealed snapshot and the retry completes it; a crash after the manifest but before sealing leaves it unsealed and the retry seals it; rerunning in the same run changes nothing | passed (within the 111) |
| Provenance | snapshot rows carry the run, producing step, repository, commit SHA and acquisition report; the driver records the clone method | as recorded in `eval/real-runs/not-so-smart-contracts/README.md` |

**Repository authorisation.** `crytic/not-so-smart-contracts` was approved earlier as the first real run: public, licensed, educational,
passive reading only. Nothing from it was executed. Clones and databases were throwaway.

**What this does NOT verify:**
- The **GitHub API path** (`GitHubSource`): the commits endpoint, the recursive tree, the tarball redirect to codeload, rate limits,
  truncated trees, and partial-snapshot policy against real responses.
- Any production worker or database.

## 2. Validating the GitHub API path (T-010): exact plan, needs approval A15

**Endpoints (read-only, unauthenticated unless the owner supplies a token outside the repository):**
1. `GET https://api.github.com/repos/{owner}/{repo}/commits/{ref}` resolves the ref to a commit SHA.
2. `GET https://api.github.com/repos/{owner}/{repo}/git/trees/{treeSha}?recursive=1` gives the tree, checked for `truncated`.
3. `GET https://api.github.com/repos/{owner}/{repo}/tarball/{commitSha}` redirects to `https://codeload.github.com/...`. Only that
   archive host is accepted, and redirects are bounded.

**Hosts to allow:** `api.github.com` and `codeload.github.com`, in this environment only, as an environment change approved by the owner.

**Boundaries:**
- One approved public repository at one pinned commit. Proposed: the same `crytic/not-so-smart-contracts` @ `020dbdb`, so the API
  path can be compared byte for byte with the clone path.
- Throwaway local database. No token in the repository. No polling and no discovery source.
- At most a handful of requests, well under the unauthenticated limit (60 per hour).

**Pass criteria:**
- The API path seals a snapshot whose manifest equals `b0d4fb23…` (the clone path's).
- Same file count, completeness `complete`.
- Same dossier content hash.
- Recorded failure classification for one deliberately bad ref (non-existent SHA → `not_found`, no snapshot).

**Not covered by that check (remains open):**
- truncated trees on very large repositories;
- the partial-snapshot policy (owner decision);
- authenticated limits;
- the production worker.
