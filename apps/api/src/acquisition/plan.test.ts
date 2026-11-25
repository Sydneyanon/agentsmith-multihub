import { describe, expect, it } from "vitest";
import { AcquisitionError } from "./errors.js";
import { DEFAULT_LIMITS, HARD_CEILINGS, resolveLimits } from "./limits.js";
import type { TreeEntry } from "./github-source.js";
import { assertSafeRef, parseRepositoryName } from "./github-source.js";
import { classifyPath, escapeForReport, isTraversalShaped, manifestPathProblem, parseLfsPointer } from "./paths.js";
import { buildPlan } from "./plan.js";
import { gitBlobSha1, GitBlobHasher } from "./git-hash.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const blob = (path: string, size: number, i = 1, mode = "100644"): TreeEntry => ({ path, mode, type: "blob", sha: sha(i), size });
const L = DEFAULT_LIMITS;

describe("limits", () => {
  it("applies defaults, accepts values within the ceiling and refuses anything outside it", () => {
    expect(resolveLimits().maxFileBytes).toBe(256 * 1024);
    expect(resolveLimits({ maxFileBytes: 1024 }).maxFileBytes).toBe(1024);
    for (const key of Object.keys(HARD_CEILINGS) as Array<keyof typeof HARD_CEILINGS>) expect(() => resolveLimits({ [key]: HARD_CEILINGS[key] + 1 }), key).toThrow(/may not exceed/);
    expect(() => resolveLimits({ maxFileBytes: 0 })).toThrow(/positive integer/);
    expect(() => resolveLimits({ maxFileBytes: 1.5 })).toThrow(/positive integer/);
    expect(() => resolveLimits({ nope: 1 } as never)).toThrow(/unknown acquisition limit/);
  });
  it("never allows a limit above what the database enforces (1 MiB blob, 64 MiB stored, 20,000 rows)", () => {
    expect(HARD_CEILINGS.maxFileBytes).toBe(1_048_576);
    expect(HARD_CEILINGS.maxStoredBytes).toBe(67_108_864);
    expect(HARD_CEILINGS.maxManifestEntries).toBe(20_000);
    expect(HARD_CEILINGS.maxPathLength).toBe(1_024);
  });
});

describe("repository and ref validation", () => {
  it("accepts owner/name and refuses anything that could alter a URL", () => {
    expect(parseRepositoryName("acme/vault")).toEqual({ owner: "acme", repo: "vault" });
    for (const bad of ["acme", "acme/vault/x", "/vault", "acme/", "acme/..", "../vault", "acme/va ult", "acme/vault?x=1", "acme/vault#frag", "acme\\vault", "a%2Fb/c", "ac me/v", "", "acme/va\u0000ult", "https://github.com/a/b"]) {
      expect(() => parseRepositoryName(bad), JSON.stringify(bad)).toThrow(AcquisitionError);
    }
  });
  it("accepts ordinary refs and refuses traversal, injection and git-special forms", () => {
    for (const ok of ["main", "v1.2.3", "feature/x-1", "release/2024.01", "a".repeat(40), "HEAD", "users/me/topic"]) expect(() => assertSafeRef(ok), ok).not.toThrow();
    for (const bad of ["", "..", "a..b", "/main", "main/", "a//b", "a@{1}", "x.lock", "-rf", "a b", "a?b", "a#b", "a%2e%2e", "a\nb", "a\\b", "a".repeat(251)]) expect(() => assertSafeRef(bad), JSON.stringify(bad)).toThrow(AcquisitionError);
  });
});

describe("manifest path rules (mirror of the database CHECK)", () => {
  it.each([
    ["a.sol", null], ["a/b/c.sol", null], ["with space/x y.sol", null], ["ünï/コード.sol", null], ["back\\slash.sol", null], [".hidden/.x", null], ["a".repeat(1024), null],
    ["", "length_out_of_range"], ["a".repeat(1025), "length_out_of_range"], ["/abs", "leading_slash"], ["a/../b", "empty_dot_or_dotdot_segment"], ["./a", "empty_dot_or_dotdot_segment"],
    ["a//b", "empty_dot_or_dotdot_segment"], ["a/", "empty_dot_or_dotdot_segment"], [".", "empty_dot_or_dotdot_segment"], ["..", "empty_dot_or_dotdot_segment"],
    ["a\tb", "tab_or_newline"], ["a\nb", "tab_or_newline"], ["a\rb", "tab_or_newline"], ["a\u0000b", "nul"], ["a\ud800b", "invalid_unicode"],
    [Array.from({ length: 65 }, () => "d").join("/"), "too_deep"],
  ])("%j -> %s", (path, expected) => { expect(manifestPathProblem(path, L)).toBe(expected); });
  it("counts characters, not UTF-16 units, as the database does", () => {
    expect(manifestPathProblem("😀".repeat(1024), L)).toBeNull();
    expect(manifestPathProblem("😀".repeat(1025), L)).toBe("length_out_of_range");
  });
  it("flags archive paths shaped like traversal", () => {
    for (const bad of ["../x", "a/../b", "/etc/passwd", "a/./b", "C:\\Windows\\x", "C:/x", "a//b", "a\u0000b"]) expect(isTraversalShaped(bad), bad).toBe(true);
    for (const ok of ["a/b", "a.b/c", "..hidden/x", "a/..b", "x..y"]) expect(isTraversalShaped(ok), ok).toBe(false);
  });
  it("escapes control characters, bidi-safe line breaks and lone surrogates, and truncates, for logs and reports", () => {
    expect(escapeForReport("a\nb\tc\u0000")).toBe("a\\u{a}b\\u{9}c\\u{0}");
    expect(escapeForReport("a\u2028b")).toBe("a\\u{2028}b");
    expect(escapeForReport("a\\b")).toBe("a\\\\b");
    expect(escapeForReport("x".repeat(500), 10)).toBe("xxxxxxxxxx…(+490 more)");
    expect(escapeForReport("\u001b[31mred")).not.toContain("\u001b");
  });
});

describe("classification", () => {
  it.each([
    ["contracts/Vault.sol", "source"], ["src/main.rs", "source"], ["test/Vault.t.sol", "test"], ["tests/a.py", "test"], ["src/a.test.ts", "test"], ["lib/forge-std/Test.sol", "vendored"],
    ["node_modules/x/index.js", "vendored"], ["a/vendor/b.go", "vendored"], ["README.md", "docs"], ["docs/guide.txt", "docs"], ["LICENSE", "docs"], ["foundry.toml", "config"],
    ["package.json", "config"], [".github/workflows/ci.yml", "config"], ["dist/app.min.js", "generated"], ["out/Vault.json", "generated"], ["a.pb.go", "generated"], ["image.png", "other"], ["Makefile", "config"],
  ])("%s is %s", (path, expected) => { expect(classifyPath(path)).toBe(expected); });
  it("is a pure function of the path", () => { expect(classifyPath("a/b.sol")).toBe(classifyPath("a/b.sol")); });
});

describe("Git LFS pointers", () => {
  const pointer = (extra = "") => Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 123456\n${extra}`);
  it("recognises a pointer and reads its object id and size", () => { expect(parseLfsPointer(pointer())).toEqual({ oid: "a".repeat(64), size: 123456 }); });
  it("rejects look-alikes", () => {
    expect(parseLfsPointer(Buffer.from("version https://git-lfs.github.com/spec/v1\n"))).toBeNull();
    expect(parseLfsPointer(Buffer.from(`oid sha256:${"a".repeat(64)}\nsize 1\n`))).toBeNull();
    expect(parseLfsPointer(Buffer.alloc(2000, 65))).toBeNull();
    expect(parseLfsPointer(Buffer.from("hello"))).toBeNull();
  });
});

describe("git object ids", () => {
  it("matches git's own blob id for known content", () => {
    expect(gitBlobSha1(Buffer.from(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"); // the empty blob
    expect(gitBlobSha1(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
  it("hashes incrementally and refuses a wrong number of bytes", () => {
    const h = new GitBlobHasher(6); h.update(Buffer.from("hel")); h.update(Buffer.from("lo\n"));
    expect(h.finish()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    const short = new GitBlobHasher(6); short.update(Buffer.from("hel"));
    expect(() => short.finish()).toThrow(/declared 6/);
    const long = new GitBlobHasher(2);
    expect(() => long.update(Buffer.from("abc"))).toThrow(/more bytes/);
  });
});

describe("planning every tree entry", () => {
  const plan = (entries: TreeEntry[], over: Partial<typeof L> = {}, exclude: string[] = []) => buildPlan(entries, { limits: { ...L, ...over }, excludePathPrefixes: exclude });
  const bad = (fn: () => unknown) => { try { fn(); return "no error"; } catch (e) { return e instanceof AcquisitionError ? e.code : "other"; } };

  it("accounts for every blob, symlink and submodule, and ignores tree entries", () => {
    const p = plan([
      { path: "src", mode: "040000", type: "tree", sha: sha(9) }, blob("src/a.sol", 10), blob("src/run.sh", 5, 2, "100755"),
      { path: "link", mode: "120000", type: "blob", sha: sha(3), size: 7 }, { path: "mod", mode: "160000", type: "commit", sha: sha(4) },
    ]);
    expect(p.items.map((i) => [i.path, i.kind, i.plannedSkip])).toEqual([["link", "symlink", "symlink"], ["mod", "submodule", "submodule"], ["src/a.sol", "file", null], ["src/run.sh", "file", null]]);
    expect(p.treeEntries).toBe(4);
  });
  it("orders by UTF-8 byte order, not locale", () => {
    const p = plan([blob("b", 1, 1), blob("B", 1, 2), blob("a", 1, 3), blob("é", 1, 4), blob("z", 1, 5)]);
    expect(p.items.map((i) => i.path)).toEqual(["B", "a", "b", "z", "é"]);
  });
  it("marks oversize files, exclusions and the byte budget, deterministically and with a greedy fit", () => {
    const entries = [blob("src/big.sol", 300_000, 1), blob("src/a.sol", 40, 2), blob("src/b.sol", 40, 3), blob("test/t.t.sol", 40, 4), blob("docs/x.md", 5, 5), blob("lib/v.sol", 6, 6), blob("skipme/y.sol", 5, 7)];
    const p = plan(entries, { maxStoredBytes: 90 }, ["skipme"]);
    const by = Object.fromEntries(p.items.map((i) => [i.path, i.plannedSkip]));
    expect(by["src/big.sol"]).toBe("oversize");
    expect(by["skipme/y.sol"]).toBe("excluded_by_policy");
    expect(by["src/a.sol"]).toBeNull(); expect(by["src/b.sol"]).toBeNull();      // source first: 80 bytes
    expect(by["test/t.t.sol"]).toBe("limit_reached");                              // 120 > 90
    expect(by["docs/x.md"]).toBeNull();                                            // 85 <= 90: a later smaller file still fits
    expect(by["lib/v.sol"]).toBe("limit_reached");                                 // vendored ranks last: 85 + 6 = 91 > 90
  });
  it("gives the same plan for the same tree, whatever the order it arrives in", () => {
    const entries = Array.from({ length: 60 }, (_, i) => blob(`dir${i % 7}/f${i}.sol`, 10 + i, i + 1));
    const a = plan(entries, { maxStoredBytes: 500 });
    const b = plan([...entries].reverse(), { maxStoredBytes: 500 });
    expect(a.items).toEqual(b.items);
  });
  it("puts paths the manifest cannot hold aside, and reports them", () => {
    const p = plan([blob("ok.sol", 1), blob("bad\tname.sol", 2, 2), blob("bad\nname.sol", 3, 3), blob("x".repeat(1100), 4, 4)]);
    expect(p.items.map((i) => i.path)).toEqual(["ok.sol"]);
    expect(p.unrepresentable.map((u) => u.reason).sort()).toEqual(["length_out_of_range", "tab_or_newline", "tab_or_newline"]);
  });
  it("refuses more than the manifest can hold, before anything is downloaded", () => {
    const many = Array.from({ length: 20_001 }, (_, i) => blob(`f${i}`, 1, i + 1));
    expect(bad(() => plan(many))).toBe("repository_too_large");
    expect(bad(() => plan(many.slice(0, 20_000)))).toBe("no error");
    const withBad = [...many.slice(0, 19_999), blob("a\tb", 1, 99_999), blob("c\td", 1, 99_998)];
    expect(bad(() => plan(withBad))).toBe("repository_too_large"); // unrepresentable entries still count against the 20,000
  });
  it("counts case-colliding paths and keeps both", () => {
    const p = plan([blob("A.sol", 1, 1), blob("a.sol", 1, 2), blob("b.sol", 1, 3)]);
    expect(p.caseCollisions).toBe(1);
    expect(p.items).toHaveLength(3);
  });
  it.each([
    ["an unknown mode", { path: "x", mode: "100664", type: "blob", sha: sha(1), size: 1 }],
    ["a blob typed as a commit", { path: "x", mode: "100644", type: "commit", sha: sha(1) }],
    ["a missing size", { path: "x", mode: "100644", type: "blob", sha: sha(1) }],
    ["a tree-mode blob", { path: "x", mode: "040000", type: "blob", sha: sha(1), size: 0 }],
  ] as Array<[string, TreeEntry]>)("fails closed on %s", (_n, entry) => { expect(bad(() => plan([entry]))).toBe("unexpected_response"); });
  it("fails on a duplicated path", () => { expect(bad(() => plan([blob("a", 1, 1), blob("a", 1, 2)]))).toBe("unexpected_response"); });
});
