# GitHub token: authenticated, read-only GitHub access

Status (2026-11-27):
- **Implemented, tested and released** as candidate `d09d0c2`, image
  `registry.fly.io/agentsmith-hub@sha256:b52ce901d3325c101d63b2840160cc2b22b63257f68c14da1e1068e3e6a2d5e0`. It is smoke-tested
  41/41 and pushed to the registry. **It is not deployed, and no Fly secret has been set.**
- **Not yet verified live:** this container cannot reach GitHub's API for arbitrary repositories, so every automated test below
  runs over loopback HTTP. Live proof is §6, which runs on Fly with your token.

## 1. The token

Create a **fine-grained personal access token** with:

| setting | value |
|---|---|
| Resource owner | your personal account |
| Expiration | your choice; 90 days is a sensible default. When it expires, the pipeline reports `auth_failed` and does not silently degrade. |
| Repository access | **Public repositories** (read-only) |
| Permissions | **Contents: Read-only** and **Metadata: Read-only**, if the form offers them. With "Public repositories" selected, GitHub may offer no further choices, because public-repository access is read-only by definition; that is enough. Everything else: **No access**. |

No write permission, no private-repository access and no account or organisation permission is needed. Nothing in the code can
write to GitHub: every request is a GET, and the tests check that both in the code and on the wire.

### Endpoints used, and the permission each needs

GitHub's permissions page could not be opened from this container (DNS for `docs.github.com` is blocked here), so the
permission column is **from my knowledge, not checked against that page**. Please check it there before creating the token.

| endpoint | used for | permission |
|---|---|---|
| `GET /repos/{owner}/{repo}` | repository lookup and verification (id, full name, default branch, `private`, `archived`, `fork`) | Metadata: read |
| `GET /repos/{owner}/{repo}/commits/{ref}` | resolving a branch, tag or HEAD to the exact commit SHA and tree SHA | Contents: read |
| `GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1` | the full git tree: paths, modes, git blob ids and sizes | Contents: read |
| `GET /repos/{owner}/{repo}/tarball/{commit_sha}` | the commit-pinned source archive. GitHub redirects this to `codeload.github.com`, which receives **no token**. | Contents: read |
| `GET /orgs/{org}/repos` | discovery monitor (disabled in production: `DISCOVERY_ENABLED` is unset) | Metadata: read |
| `GET /rate_limit` | live check only; GitHub documents that this call does not count against the limit | none |

Source files are not fetched one by one. They come from the commit-pinned tarball, and **every file is verified against its git
blob id from the tree** before it is stored. That is stronger than per-file downloads: what is sealed is exactly the content of
that commit. The contents and blob endpoints are not used.

### Rate limits

- Unauthenticated: 60 requests per hour per outbound IP.
- Authenticated: the token's own limit, 5,000 requests per hour for a personal token.
- One repository acquisition uses 4 API requests plus the archive download. One enrichment verification uses 1.

## 2. How it connects to the pipeline

There is no separate GitHub integration. The token feeds the one existing client, `GitHubSource`, which sits behind the
`RepositorySource` interface that the research pipeline already uses. The pipeline stages and where the token is used:

1. **Bounty programme** (official sources; no GitHub involved).
2. **Official repository discovery.** `enrich-main`: repository links are extracted from the official programme page.
3. **GitHub verification.** `GitHubSource.getRepository` confirms that the repository exists, is public and has a stable id.
   The mapping is recorded as `official_documentation` with the GitHub id. A refusal is recorded as `verification_deferred`,
   never as verified.
4. **Commit-pinned acquisition.** The worker's `acquire_repository` step resolves the commit, reads the tree and downloads the
   tarball for that exact commit.
5. **Snapshot sealing.** Every file is checked against its git blob id, the manifest is hashed and the snapshot is sealed.
6. **Research engine, vulnerability analysis and dossier.** These are unchanged and use the sealed snapshot only; no GitHub
   access happens after sealing.

`monitor-main` uses the same client for the HEAD checks that trigger rescans.

**What the token improves:** the rate limit goes from 60 to 5,000 requests per hour, so verification and acquisition stop being
deferred by rate limiting. Without it, about 15 acquisitions an hour would exhaust the unauthenticated limit, which is shared with
everything else on the machine's IP.

Behaviour is defined for every token state:

| `GITHUB_TOKEN` | behaviour |
|---|---|
| unset | unauthenticated (60/hour); everything works more slowly |
| well-formed | authenticated |
| malformed (e.g. a trailing newline, quotes, the wrong secret) | **not sent at all**; engine status reports `github.mode = misconfigured` and raises an attention reason |
| expired or revoked (GitHub answers 401) | permanent `auth_failed` naming the secret to fix; no retries |
| policy refusal (403 that is not a rate limit) | permanent `access_denied` |
| rate limited (403 with `x-ratelimit-remaining: 0`, or 429 with `retry-after`) | retryable; the worker waits as long as GitHub asked |

## 3. Secret handling

- **Read in exactly one place:** `apps/api/src/net/github-auth.ts`. No other code reads `GITHUB_TOKEN`; a test checks this.
- **Where it is sent:** only as `authorization: Bearer …`, and only to `https://api.github.com`. It is never sent to
  `codeload.github.com`, raw content hosts or any redirect target (tested).
- **Never stored** in the database, never put in an API response (engine status shows only the mode), never in a dossier or a
  hypothesis, and never in a model prompt (no model is called on this path, and prompts are built only from sealed snapshot code).
- **Redacted:** every `AcquisitionError` message and its details are redacted when the error is created. That removes the
  configured value, GitHub token shapes (`github_pat_…`, `ghp_…`), authorization headers and bearer values. Errors are the only
  path by which upstream text reaches step outputs and logs. The live check redacts its own output as well.
- **Never logged:** no code logs request headers or the environment.

## 4. Which machines and processes can read it

Fly secrets are **app-wide**: every machine in the app `agentsmith-hub` receives `GITHUB_TOKEN` as an environment variable when
it starts.

| machine | process | uses the token? |
|---|---|---|
| `late-meadow-8506` (API) | `server.js` | reads only whether it is well-formed, for engine status; never sends it |
| `8747e47a1501d8` (bounty-collector) | `collect-main.js` | no; its sources are bounty platforms, not GitHub |
| one-off machines (migrate, grants) | `migrate.js`, `apply-runtime-grants.js` | no |
| enrichment, bridge, monitor (A6, A9) | `enrich-main.js`, `promote-main.js`, `monitor-main.js` | enrichment and monitor: yes, for verification and HEAD checks. Bridge: no. |
| research worker (A8, A9) | `worker-main.js` | yes, for acquisition |
| live check (§6) | `github-live-check.js` | yes, read-only |

Anyone who can run `fly ssh console` or `fly machine run` in this app can read the secret. That is the same set of people who can
already read `DATABASE_URL`.

## 5. Setting the Fly secret (you do this; do not paste the token into any chat)

Run this in your own terminal. The token is not echoed and does not enter your shell history:

```sh
read -rs GH_PAT && printf 'GITHUB_TOKEN=%s\n' "$GH_PAT" | fly secrets import --app agentsmith-hub --stage; unset GH_PAT
fly secrets list --app agentsmith-hub        # shows the name GITHUB_TOKEN and a digest, never the value
```

- **Paste carefully:** paste the token at the silent prompt and press Enter once. A trailing space or newline makes it
  `misconfigured`, and it is then never sent.
- **Why `--stage`:** the secret is stored but no machine restarts. It is released with the next deploy (A1).
- **To remove it:** `fly secrets unset GITHUB_TOKEN --app agentsmith-hub --stage`. On the next deploy, the pipeline falls back to
  unauthenticated access.

## 6. Live authenticated test (after the secret is set; read-only; stores nothing)

This needs a release that contains the live check: candidate `d09d0c2` (`sha256:b52ce901…`). The earlier frozen candidate
`5d6ccd1` reads `GITHUB_TOKEN` too, but has neither the live check nor this hardening.

```sh
fly machine run registry.fly.io/agentsmith-hub@sha256:b52ce901d3325c101d63b2840160cc2b22b63257f68c14da1e1068e3e6a2d5e0 \
  --app agentsmith-hub --region syd --rm --restart no \
  --entrypoint node -- /app/dist/apps/api/src/acquisition/github-live-check.js octocat/Hello-World --require-auth
```

What each output line proves:

1. `{"check":"auth_mode","mode":"authenticated"}`: the secret reached the machine and is well-formed. If the line says
   `unauthenticated` and you used `--stage`, the secret is not released yet: run the check again after A1, or release it with
   `fly secrets deploy --app agentsmith-hub`, which restarts the app's machines.
2. `{"check":"rate_limit","limit":5000,…,"authenticated_limit":true}`: GitHub accepted the token.
3. `{"check":"acquisition",…,"commit_sha":"…","manifest_sha256":"…","completeness":"complete"}`: the production acquisition
   path ran against real GitHub. That covers repository lookup, default branch, commit SHA, recursive tree, commit-pinned tarball,
   every file verified against its git blob id, and a sealed manifest. It is held in memory and discarded when the process exits.
4. `{"result":"PASS","authenticated":true,…}`.

Exit codes:

| code | meaning |
|---|---|
| 0 | pass |
| 2 | not authenticated |
| 1 | failure; the last line names the error code, e.g. `auth_failed` |

The output never contains the token. Running the check counts as a one-off machine run in the app, so it needs your approval like
every other production action. After it passes, A6 (enrichment) exercises the token in the real pipeline by verifying bounty
repositories.

## 7. Tests (automated, loopback, not live)

Run with `npm test`. All 18 tests are in `apps/api/src/acquisition/github-token.test.ts`. They use loopback HTTP servers that
serve a real git repository built locally: a real commit, tree, blob ids and a real `git archive` tarball. The production client
and acquisition code run unchanged.

| # | requirement | test |
|---|---|---|
| 1–5 | authenticated access, metadata, commit SHA, tree and source retrieval, commit-pinned archive | full `acquireRepository` over HTTP: identity, default branch, commit, tree, archive by exact commit id, every file verified, sealed manifest, token on every API call and never on the archive host |
| 6 | rate limits | primary (403, remaining 0) and secondary (429 with `retry-after`) are retryable with the requested wait; rate-limit headers are recorded |
| 7 | authentication failure | 401 gives permanent `auth_failed` naming the secret, not the token, with no retry; a policy 403 gives `access_denied` |
| 8 | missing token | the same pipeline works unauthenticated, with no header; malformed values are never sent |
| 9 | redaction | token shapes, headers, JSON-quoted headers and the exact value are redacted; errors are redacted at construction; live-check output carries no token even when the server echoes the credential |
| 10 | no writes | every request on the wire is a bodiless GET; no GitHub client in the source tree contains a non-GET method |

- **Engine status:** the integration test checks the reported mode, that a malformed secret raises an attention reason, and that
  the token is never in the response.
- **Image smoke test:** inside the built image, the live check ships, refuses to run without a token, and never echoes a malformed one.
