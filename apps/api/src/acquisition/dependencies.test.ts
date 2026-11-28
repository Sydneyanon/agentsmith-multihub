import { describe, expect, it } from "vitest";
import { AcquisitionError } from "./errors.js";
import { dependencyDigest, failureOfAcquisition, parseFoundryRemappings, parseGitmodulesFull, parsePackages, parseRemappingsTxt, resolveDependencySet, submoduleRepository, usableRemappings,
  type ConfigFiles, type DependencyIo, type DependencyRequest } from "./dependencies.js";
import type { TreeEntry } from "./github-source.js";

/** C3: the dependency resolver as a pure function of trees and stored configuration files. No source, no network, no database. */
const sha = (c: string) => c.repeat(40);
const blob = (path: string): TreeEntry => ({ path, mode: "100644", type: "blob", sha: sha("b"), size: 1 });
const link = (path: string, commit: string): TreeEntry => ({ path, mode: "160000", type: "commit", sha: commit });
const PARENT = { snapshotId: "parent", repository: "acme/app", commitSha: sha("a"), manifestSha256: "f".repeat(64) };

type World = { trees: Record<string, TreeEntry[]>; config: Record<string, ConfigFiles>; missing?: string[]; large?: string[] };
function io(w: World, log: DependencyRequest[] = []): DependencyIo {
  return {
    tree: async (repository, commitSha) => { const t = w.trees[`${repository}@${commitSha}`]; if (!t) throw new AcquisitionError("commit_unavailable", "no such commit"); return { treeSha: `${commitSha.slice(0, 39)}t`, entries: t }; },
    configFiles: async (id) => w.config[id] ?? {},
    acquire: async (dep) => {
      log.push(dep);
      if (w.missing?.includes(dep.repository)) return { ok: false, code: "unavailable", reason: "repository_not_found: no such repository" };
      if (w.large?.includes(dep.repository)) return { ok: false, code: "too_large", reason: "repository_too_large: too many entries" };
      return { ok: true, snapshotId: `snap:${dep.repository}`, treeSha: `${dep.commitSha.slice(0, 39)}t`, manifestSha256: "e".repeat(64), fileCount: 3, storedBytes: 100, completeness: "complete" };
    },
  };
}
const gm = (...mods: Array<[string, string | null]>) => mods.map(([path, url]) => `[submodule "${path}"]\n\tpath = ${path}\n${url ? `\turl = ${url}\n` : ""}`).join("");

describe("C3 parsing", () => {
  it(".gitmodules: paths and URLs per section, nothing guessed", () => {
    expect(parseGitmodulesFull(gm(["lib/a", "https://github.com/o/a"], ["lib/b", null]) + "[core]\n\turl = https://evil.example/x\n")).toEqual([{ name: "lib/a", path: "lib/a", url: "https://github.com/o/a" }, { name: "lib/b", path: "lib/b", url: null }]);
  });

  it("only github.com repositories are accepted as a submodule source; every other host is refused by name", () => {
    expect(submoduleRepository("https://github.com/foundry-rs/forge-std", "acme/app")).toEqual({ ok: true, repository: "foundry-rs/forge-std", sourceUrl: "https://github.com/foundry-rs/forge-std" });
    expect(submoduleRepository("https://github.com/o/r.git/", "acme/app")).toMatchObject({ ok: true, repository: "o/r" });
    expect(submoduleRepository("git@github.com:o/r.git", "acme/app")).toMatchObject({ ok: true, repository: "o/r", sourceUrl: "https://github.com/o/r" });
    expect(submoduleRepository("ssh://git@github.com/o/r", "acme/app")).toMatchObject({ ok: true, repository: "o/r" });
    expect(submoduleRepository("../sibling.git", "acme/app")).toMatchObject({ ok: true, repository: "acme/sibling" });
    expect(submoduleRepository("../../other/lib", "acme/app")).toMatchObject({ ok: true, repository: "other/lib" });
    for (const bad of ["https://gitlab.com/o/r.git", "git@bitbucket.org:o/r.git", "https://github.com.evil.example/o/r", "http://169.254.169.254/latest", "https://user:pw@internal.host/o/r", "file:///etc/passwd", "/abs/path", "../../../escape", "https://github.com/only-owner"]) {
      expect(submoduleRepository(bad, "acme/app").ok, bad).toBe(false);
    }
    expect(submoduleRepository("https://gitlab.com/o/r.git", "acme/app")).toMatchObject({ ok: false, reason: expect.stringMatching(/gitlab\.com is not on the acquisition allow-list/) });
  });

  it("remappings.txt and foundry.toml are read as declared; an unreadable entry is counted, never dropped silently", () => {
    expect(parseRemappingsTxt("# c\nforge-std/=lib/forge-std/src/\nctx:@oz/=./node_modules/@oz/\n\nnot a remapping\n")).toEqual({ unreadable: [5], remappings: [
      { context: null, prefix: "forge-std/", target: "lib/forge-std/src/", declared_in: "remappings.txt", line: 2 }, { context: "ctx", prefix: "@oz/", target: "node_modules/@oz/", declared_in: "remappings.txt", line: 3 }] });
    const toml = "[profile.default]\nsrc = 'src'\nremappings = [\n  \"a/=lib/a/src/\", # comment\n  'b/=lib/b/',\n]\nlibs = ['lib']\n[profile.ci]\nremappings = [\"c/=lib/c/\"]\n";
    expect(parseFoundryRemappings(toml).remappings.map((r) => [r.prefix, r.target, r.line])).toEqual([["a/", "lib/a/src/", 4], ["b/", "lib/b/", 5], ["c/", "lib/c/", 9]]);
  });

  it("a package is pinned only by a lockfile entry with an integrity hash; otherwise it is unavailable; none is ever fetched", () => {
    const pj = JSON.stringify({ dependencies: { "@oz/contracts": "5.0.2", loose: "^1" }, devDependencies: { hardhat: "2.0.0" } });
    const lock = JSON.stringify({ packages: { "node_modules/@oz/contracts": { version: "5.0.2", resolved: "https://registry.npmjs.org/x.tgz", integrity: "sha512-AAAA" }, "node_modules/hardhat": { version: "2.0.0" } } });
    const r = parsePackages(pj, lock, 100).packages;
    expect(r.map((p) => [p.name, p.status, p.pin_established_by, p.version])).toEqual([["@oz/contracts", "pinned_not_acquired", "package-lock.json integrity", "5.0.2"], ["hardhat", "unavailable", null, null], ["loose", "unavailable", null, null]]);
    expect(parsePackages(pj, null, 100).packages.every((p) => p.status === "unavailable" && /no package-lock\.json/.test(p.reason))).toBe(true);
    expect(parsePackages("{not json", null, 100)).toEqual({ packages: [], problems: ["package.json is not valid JSON"] });
    expect(parsePackages(null, null, 100).packages).toEqual([]);
  });
});

describe("C3 resolution", () => {
  const world = (): World => ({
    trees: {
      [`acme/app@${sha("a")}`]: [blob("src/A.sol"), blob(".gitmodules"), link("lib/ok", sha("1")), link("lib/other-host", sha("2")), link("lib/gone", sha("3")), link("lib/no-url", sha("4")), link("lib/big", sha("5"))],
      [`o/ok@${sha("1")}`]: [blob("src/Ok.sol"), blob(".gitmodules"), link("lib/inner", sha("6"))],
      [`o/inner@${sha("6")}`]: [blob("src/Inner.sol"), blob(".gitmodules"), link("lib/too-deep", sha("7"))],
    },
    config: {
      parent: { ".gitmodules": gm(["lib/ok", "https://github.com/o/ok"], ["lib/other-host", "https://gitlab.com/o/x"], ["lib/gone", "https://github.com/o/gone"], ["lib/floating", "https://github.com/o/floating"], ["lib/big", "https://github.com/o/big"]),
        "remappings.txt": "ok/=lib/ok/src/\ngone/=lib/gone/src/\nlocal/=src/\nnowhere/=vendor/x/\n@oz/=node_modules/@oz/contracts/\n" },
      "snap:o/ok": { ".gitmodules": gm(["lib/inner", "../inner"]) },
      "snap:o/inner": { ".gitmodules": gm(["lib/too-deep", "https://github.com/o/deep"]) },
    },
    missing: ["o/gone"], large: ["o/big"],
  });

  it("the commit of every dependency comes only from the parent tree's gitlink; each case is a record with a status and a reason", async () => {
    const asked: DependencyRequest[] = [];
    const m = await resolveDependencySet(io(world(), asked), PARENT);
    expect(m.dependencies.map((d) => [d.path, d.status, d.depth, d.pinned_commit, d.pin_established_by])).toEqual([
      ["lib/big", "too_large", 1, sha("5"), "gitlink_in_parent_tree"],
      ["lib/floating", "unpinned", 1, null, null],
      ["lib/gone", "unavailable", 1, sha("3"), "gitlink_in_parent_tree"],
      ["lib/no-url", "missing_url", 1, sha("4"), "gitlink_in_parent_tree"],
      ["lib/ok", "acquired", 1, sha("1"), "gitlink_in_parent_tree"],
      ["lib/ok/lib/inner", "acquired", 2, sha("6"), "gitlink_in_parent_tree"],
      ["lib/ok/lib/inner/lib/too-deep", "nested_depth_exceeded", 3, sha("7"), "gitlink_in_parent_tree"],
      ["lib/other-host", "disallowed_host", 1, sha("2"), "gitlink_in_parent_tree"],
    ]);
    // ONLY pinned, allowed, in-depth dependencies were ever requested, each at exactly its gitlink commit
    expect(asked.map((a) => [a.repository, a.commitSha, a.path]).sort()).toEqual([["o/big", sha("5"), "lib/big"], ["o/gone", sha("3"), "lib/gone"], ["o/inner", sha("6"), "lib/ok/lib/inner"], ["o/ok", sha("1"), "lib/ok"]]);
    expect(asked.some((a) => !/^[0-9a-f]{40}$/.test(a.commitSha))).toBe(false);
    const inner = m.dependencies.find((d) => d.path === "lib/ok/lib/inner")!;
    expect(inner).toMatchObject({ repository: "o/inner", source_url: "https://github.com/o/inner", parent: { repository: "o/ok", commit_sha: sha("1"), path_in_parent: "lib/inner" }, snapshot_id: "snap:o/inner", manifest_sha256: "e".repeat(64) });
    for (const d of m.dependencies) if (d.status !== "acquired") { expect(d.reason, d.path).toBeTruthy(); expect(d.snapshot_id).toBeNull(); expect(m.limitations.some((l) => l.code === d.status && l.subject === d.path), d.path).toBe(true); }
    expect(m.dependencies.find((d) => d.path === "lib/floating")!.reason).toMatch(/no pinned commit, and a branch head is never fetched/);
  });

  it("remappings resolve to the snapshot, an acquired dependency, a package or nothing; only available ones are usable", async () => {
    const m = await resolveDependencySet(io(world()), PARENT);
    expect(m.remappings.map((r) => [r.prefix, r.resolves_to.kind, r.available])).toEqual([["ok/", "dependency", true], ["gone/", "dependency", false], ["local/", "parent_snapshot", true], ["nowhere/", "unresolved", false], ["@oz/", "package", false]]);
    expect(usableRemappings(m)).toEqual(["ok/=lib/ok/src/", "local/=src/"]);
    expect(m.limitations.filter((l) => l.code === "remapping_target_missing").map((l) => l.subject)).toEqual(["gone/=lib/gone/src/", "nowhere/=vendor/x/"]);
    expect(m.limitations.find((l) => l.code === "package_unpinned")).toMatchObject({ subject: "@oz/contracts" });
  });

  it("the same parent commit gives the same set and digest; any change to a pin, a status or a remapping changes the digest", async () => {
    const a = await resolveDependencySet(io(world()), PARENT); const b = await resolveDependencySet(io(world()), { ...PARENT, snapshotId: "parent" });
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/); expect(b.digest).toBe(a.digest); expect(b).toEqual(a);
    const { digest, ...body } = a; expect(dependencyDigest(body)).toBe(digest);
    const moved = world(); moved.trees[`acme/app@${sha("a")}`] = moved.trees[`acme/app@${sha("a")}`]!.map((e) => (e.path === "lib/ok" ? link("lib/ok", sha("9")) : e)); moved.trees[`o/ok@${sha("9")}`] = [blob("src/Ok.sol")];
    expect((await resolveDependencySet(io(moved), PARENT)).digest).not.toBe(a.digest);
    const back = world(); back.missing = [];
    back.trees[`o/gone@${sha("3")}`] = [blob("src/G.sol")];
    expect((await resolveDependencySet(io(back), PARENT)).digest).not.toBe(a.digest);
    // run-specific snapshot ids and reason texts are not part of the digest
    expect(dependencyDigest({ ...body, dependencies: body.dependencies.map((d) => ({ ...d, snapshot_id: d.snapshot_id ? "another-run" : null, reason: d.reason ? "other words" : null })) })).toBe(digest);
  });

  it("limits are explicit: depth, count and total size each produce a recorded limitation", async () => {
    const shallow = await resolveDependencySet(io(world()), PARENT, { maxDepth: 1 });
    expect(shallow.dependencies.find((d) => d.path === "lib/ok/lib/inner")).toMatchObject({ status: "nested_depth_exceeded", snapshot_id: null });
    const few = await resolveDependencySet(io(world()), PARENT, { maxDependencies: 0 });
    expect(few.dependencies.filter((d) => d.status === "dependency_limit_reached").map((d) => d.path)).toEqual(["lib/big", "lib/gone", "lib/ok"]);
    const small = await resolveDependencySet(io(world()), PARENT, { maxTotalStoredBytes: 50 });
    expect(small.dependencies.find((d) => d.path === "lib/ok/lib/inner")).toMatchObject({ status: "too_large" });
    const none = await resolveDependencySet(io({ trees: { [`acme/app@${sha("a")}`]: [blob("src/A.sol")] }, config: {} }), PARENT);
    expect([none.dependencies, none.remappings, none.packages, none.limitations]).toEqual([[], [], [], []]);
  });

  it("only definite answers become a limitation; a transient failure is never recorded as 'unavailable'", () => {
    expect(failureOfAcquisition(new AcquisitionError("repository_not_found", "gone"))).toMatchObject({ ok: false, code: "unavailable" });
    expect(failureOfAcquisition(new AcquisitionError("commit_unavailable", "gone"))).toMatchObject({ code: "unavailable" });
    expect(failureOfAcquisition(new AcquisitionError("repository_too_large", "big"))).toMatchObject({ code: "too_large" });
    expect(failureOfAcquisition(new AcquisitionError("network", "reset", true))).toBeNull();
    expect(failureOfAcquisition(new AcquisitionError("timeout", "slow", true))).toBeNull();
    expect(failureOfAcquisition(new AcquisitionError("archive_tree_mismatch", "tampered"))).toBeNull(); // an integrity failure fails the step
    expect(failureOfAcquisition(new Error("boom"))).toBeNull();
  });
});
