# DRAFT C3: dependency links and package snapshots

- **Status:** draft only (2026-11-28). **Not applied anywhere.** It was applied and rolled back once on a throwaway local database to
  check that the SQL is valid; it has no integration test of its own and no application code uses it.
- **Requires:** 0007. Independent of the other drafts.
- **Needs the owner's approval**, in two separate decisions: the link table (schema only), and package acquisition (schema **and** a
  source-access policy change, because it adds a new outbound host).

## What C3 does today, without it

Git submodules are acquired at the commit the parent tree pins, each as its own sealed `repo_snapshots` row in the same run (the existing
unique key is run + repository + commit). The link to the analysed snapshot is recorded in JSON, in two places:

- `acquisition_report.dependency_of` of the dependency snapshot (immutable once the snapshot is sealed);
- the dependency manifest: the `acquire_dependencies` step output and a content-addressed blob, with a digest that every consumer
  re-checks (`acquisition/dependency-step.ts: dependencyManifestOfRun`).

Packages under `node_modules` are **recorded but never fetched**: a package the lockfile pins with an integrity hash is
`pinned_not_acquired`; any other is `unavailable`.

## Part 1: `snapshot_dependencies` (why a table)

| the JSON gives | the table would add |
|---|---|
| the link, checked by the application | a **foreign key** from the link to both snapshots, so a dependency cannot name a snapshot of another run or a missing one |
| the pin, as a field | a database check that the dependency snapshot **is of exactly the pinned commit**, and that nothing is `acquired` without a pin |
| one manifest per run | a row per dependency, **including the ones that were not acquired**, queryable ("which runs could not get `lib/x`, and why") |
| immutability by convention for the step output | the append-only trigger every research record has |

## Part 2: `package_snapshots` (why packages cannot be stored now)

`repo_snapshots` cannot hold a package: `source_host` is checked to be `github.com`, the identity is a 40-hex `commit_sha`, and the
content is verified against git object ids. A package tarball has none of these. Relaxing those checks would weaken constraints the
acquisition path relies on, so the draft adds separate tables instead and **changes no existing constraint**:

- identity is the lockfile's `integrity` string; the acquirer recomputes the sha512 of the downloaded bytes and both are stored;
- the only registry host the table accepts is `registry.npmjs.org`.

**This is half of the work.** Acquiring a package also needs, and this draft does not contain:

1. a package source with the same guards as `GitHubSource` (allow-listed host, no redirects off it, size and time limits, safe tar
   extraction), and the owner's approval of the new outbound host;
2. under option D, the API's own re-download and integrity check before a package snapshot is accepted from a worker;
3. resolution of a package's own dependencies (the lockfile lists them; none is followed today).

Until then a pinned package stays `pinned_not_acquired`, with that reason.

## Grants (if promoted)

`SELECT, INSERT` on the three tables for the runtime role; nothing else.

## Rollback

`c3_dependency_records.rollback.sql` drops the tables and the guard function.
