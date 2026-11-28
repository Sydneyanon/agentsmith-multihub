import { describe, expect, it } from "vitest";
import type { DependencyManifest } from "../../acquisition/dependencies.js";
import { leadKey, normaliseFunction } from "./lead-identity.js";
import { computeStructuralAnalysis } from "./pipeline.js";
import { buildProtocolModel } from "./protocol-model.js";
import { buildSharedModel, importsOf, modelReadRecord, SECTION_KEYS, SHARED_MODEL_SCHEMA, verifySharedModel, type SharedModelContext, type SharedProtocolModel } from "./shared-model.js";

/** C1: the shared protocol model as a pure function of the sealed sources, the snapshot identity and the dependency manifest. */
const SNAP = { repository: "acme/vault", commit_sha: "a".repeat(40), manifest_sha256: "b".repeat(64) };
const VAULT = `pragma solidity ^0.8.20;
import {Lib} from "dep/Lib.sol";
import "./Other.sol";
import "@oz/contracts/token/ERC20.sol";
// import "commented/Out.sol";
interface IToken { function transfer(address to, uint256 v) external returns (bool); }
contract Vault {
    address public owner;
    address public implementation;
    bool private initialized;
    mapping(address => uint256) public balances;
    uint256[] public history;
    IToken public token;
    function initialize(address o) external { require(!initialized); initialized = true; owner = o; }
    function deposit() external payable { balances[msg.sender] += msg.value; history.push(block.timestamp); }
    function withdraw() external { uint256 a = balances[msg.sender]; (bool ok, ) = msg.sender.call{value: a}(""); require(ok); balances[msg.sender] = 0; }
    function setImplementation(address i) external { require(msg.sender == owner); implementation = i; }
    function sweep(address to) external { require(msg.sender == owner); token.transfer(to, 1); }
    function digest(bytes memory d) external pure returns (bytes32) { return keccak256(d); }
    fallback() external payable { (bool ok, ) = implementation.delegatecall(msg.data); require(ok); }
}
`;
const SOURCES = [{ path: "src/Vault.sol", text: VAULT }, { path: "src/Other.sol", text: "pragma solidity ^0.8.20;\ncontract Other { uint256 x; function set(uint256 v) external { x = v; } }\n" }];
const ctx = (dependencies: SharedModelContext["dependencies"] = null): SharedModelContext => ({ snapshot: SNAP, dependencies });
const build = (c = ctx()) => buildSharedModel(SOURCES, buildProtocolModel(SOURCES), c);
const computed = <K extends keyof SharedProtocolModel["sections"]>(doc: SharedProtocolModel, k: K) => { const s = doc.sections[k]; if (s.status !== "computed") throw new Error(`${k} not computed`); return s as Extract<SharedProtocolModel["sections"][K], { status: "computed" }>; };
const MANIFEST: DependencyManifest = {
  schema: "agentsmith-dependency-manifest/1", resolver: "agentsmith-dependency-resolver/1", parent: { repository: SNAP.repository, commit_sha: SNAP.commit_sha, tree_sha: "c".repeat(40), manifest_sha256: SNAP.manifest_sha256 },
  limits: { maxDepth: 2, maxDependencies: 24, maxTotalStoredBytes: 1, maxPackages: 1 },
  dependencies: [{ kind: "git_submodule", path: "lib/dep", depth: 1, parent: { repository: SNAP.repository, commit_sha: SNAP.commit_sha, tree_sha: "c".repeat(40), path_in_parent: "lib/dep" }, declared_url: "https://github.com/o/dep", source_url: "https://github.com/o/dep", repository: "o/dep",
    pinned_commit: "d".repeat(40), pin_established_by: "gitlink_in_parent_tree", status: "acquired", reason: null, tree_sha: "e".repeat(40), manifest_sha256: "1".repeat(64), file_count: 1, stored_bytes: 10, completeness: "complete", snapshot_id: "s" }],
  remappings: [{ context: null, prefix: "dep/", target: "lib/dep/src/", declared_in: "remappings.txt", line: 1, resolves_to: { kind: "dependency", path: "lib/dep", status: "acquired" }, available: true }],
  packages: [{ name: "@oz/contracts", declared_range: "5", version: null, resolved: null, integrity: null, pin_established_by: null, status: "unavailable", reason: "no package-lock.json in the snapshot: the package is unpinned and is never fetched" }],
  limitations: [{ code: "package_unpinned", subject: "@oz/contracts", reason: "unpinned", established_by: "resolver" }], digest: "9".repeat(64),
};

describe("the shared protocol model (C1)", () => {
  it("every section is present with an explicit status; uncomputed sections give a reason; nothing is `verified` or presented as understood", () => {
    const { doc } = build();
    expect(doc.schema).toBe(SHARED_MODEL_SCHEMA); expect(Object.keys(doc.sections).sort()).toEqual([...SECTION_KEYS].sort());
    for (const k of SECTION_KEYS) { const s = doc.sections[k]; if (s.status === "computed") { expect(s.provenance.snapshot, k).toEqual(SNAP); expect(s.provenance.analysis.length, k).toBeGreaterThan(0); expect(s.note.length, k).toBeGreaterThan(20); expect(["parsed", "derived", "unknown"], k).toContain(s.epistemic); } else expect(s.reason.length, k).toBeGreaterThan(20); }
    expect(doc.sections.assets_accounting).toMatchObject({ status: "not_computed" }); expect(doc.sections.invariants).toMatchObject({ status: "not_computed" });
    expect(computed(doc, "actors_permissions").actors).toMatchObject({ status: "not_computed" });
    expect(computed(doc, "external_dependencies").dependency_set).toMatchObject({ status: "not_computed", reason: expect.stringMatching(/not requested/) });
    expect(JSON.stringify(doc)).not.toMatch(/"epistemic":"verified"/);
    expect(doc.snapshot).toEqual(SNAP); expect(doc.inputs.map((i) => i.file)).toEqual(["src/Other.sol", "src/Vault.sol"]);
  });

  it("state: who writes each variable, as derived facts with their location", () => {
    const vars = computed(build().doc, "state").variables; const v = (n: string) => vars.find((x) => x.component === "Vault" && x.variable === n)!;
    expect(v("balances")).toMatchObject({ epistemic: "derived", type: "mapping ( address => uint256 )", at: [{ file: "src/Vault.sol", line_start: 11, line_end: 11 }] });
    expect(v("balances").writers.map((w) => w.function).sort()).toEqual(["Vault.deposit()", "Vault.withdraw()"]);
    expect(v("implementation").writers).toEqual([{ function: "Vault.setImplementation(address)", entry_point: true, caller_guarded: true }]);
    expect(v("owner").writers.map((w) => [w.function, w.caller_guarded])).toEqual([["Vault.initialize(address)", false]]);
    expect(v("token").writers).toEqual([]); // nothing writes it: an empty writer list of a COMPUTED fact, stated as such
  });

  it("permissions: guards per function, described and located, never certified", () => {
    const p = computed(build().doc, "actors_permissions"); const f = (id: string) => p.functions.find((x) => x.function === id)!;
    expect(f("Vault.setImplementation(address)")).toMatchObject({ caller_guarded: true, entry_point: true, epistemic: "derived" });
    expect(f("Vault.setImplementation(address)").guards[0]).toMatchObject({ side: "caller-side", enforcement: "reverting", at: { file: "src/Vault.sol", line_start: 17 } });
    expect(f("Vault.withdraw()").caller_guarded).toBe(false);
    expect(p.note).toMatch(/described, never certified/);
  });

  it("external call targets are the expression as written; upgradeability markers are parsed or derived, and an empty list is not a claim", () => {
    const ext = computed(build().doc, "external_dependencies");
    expect(ext.external_calls.map((c) => [c.from, c.kind, c.target, c.epistemic]).sort()).toEqual([
      ["Vault.fallback", "delegatecall", "implementation", "parsed"], ["Vault.sweep(address)", "external", "token", "parsed"], ["Vault.withdraw()", "low-level-call", "msg.sender", "parsed"]]);
    const up = computed(build().doc, "upgradeability");
    expect([...new Set(up.markers.map((m) => m.kind))].sort()).toEqual(["delegatecall", "implementation_pointer", "initializer", "proxy_boundary"]);
    expect(up.markers.find((m) => m.kind === "delegatecall")).toMatchObject({ epistemic: "parsed", component: "Vault", at: [{ file: "src/Vault.sol", line_start: 20 }] });
    const plain = buildSharedModel([SOURCES[1]!], buildProtocolModel([SOURCES[1]!]), ctx()).doc;
    expect(computed(plain, "upgradeability").markers).toEqual([]); expect(computed(plain, "upgradeability").note).toMatch(/NOT evidence that the code is not upgradeable/);
  });

  it("unsupported features: a syntactic prediction in the APEX gate's vocabulary, labelled as a prediction", () => {
    const u = computed(build().doc, "unsupported_features");
    expect(u.epistemic).toBe("parsed"); expect(u.note).toMatch(/A PREDICTION from syntax/); expect(u.gate_observations).toMatchObject({ status: "not_computed" });
    expect(Object.keys(u.by_feature).sort()).toEqual(["array", "block", "external-call", "hashing", "other-contract", "proxy"]);
    expect(u.predicted.find((p) => p.feature === "proxy")).toMatchObject({ component: "Vault", function: "fallback", at: [{ file: "src/Vault.sol", line_start: 20 }] });
    expect(u.predicted.every((p) => p.epistemic === "parsed" && p.at.length === 1)).toBe(true);
  });

  it("imports are read from the text and resolved only against what is really there; the rest are open questions", () => {
    expect(importsOf(VAULT)).toEqual([{ path: "dep/Lib.sol", line: 2 }, { path: "./Other.sol", line: 3 }, { path: "@oz/contracts/token/ERC20.sol", line: 4 }]);
    const without = computed(build().doc, "external_dependencies").imports;
    expect(without.map((i) => [i.path, i.resolution])).toEqual([["dep/Lib.sol", "unresolved"], ["./Other.sol", "in_snapshot"], ["@oz/contracts/token/ERC20.sol", "unresolved"]]);
    expect(without[0]!.reason).toMatch(/dependency acquisition was not requested/); expect(without[0]!.epistemic).toBe("unknown");
    const doc = build(ctx({ manifest: MANIFEST, files: { "lib/dep": ["src/Lib.sol"] } })).doc;
    const imports = computed(doc, "external_dependencies").imports;
    expect(imports[0]).toMatchObject({ path: "dep/Lib.sol", resolution: "dependency", resolved_path: "lib/dep/src/Lib.sol", dependency: "lib/dep" });
    expect(imports[2]).toMatchObject({ resolution: "unresolved", dependency: "node_modules/@oz/contracts", reason: expect.stringMatching(/package @oz\/contracts is unavailable/) });
    // an acquired dependency that does not hold the imported file is still unresolved
    const missing = computed(build(ctx({ manifest: MANIFEST, files: { "lib/dep": ["src/Else.sol"] } })).doc, "external_dependencies").imports[0]!;
    expect(missing).toMatchObject({ resolution: "unresolved", reason: expect.stringMatching(/holds no file src\/Lib\.sol/) });
    const set = computed(doc, "external_dependencies").dependency_set;
    expect(set).toMatchObject({ status: "computed", digest: MANIFEST.digest, acquired: [{ path: "lib/dep", pinned_commit: "d".repeat(40) }], remappings: ["dep/=lib/dep/src/"] });
    const q = computed(doc, "unresolved_questions").questions;
    expect(q.some((x) => x.raised_by === "import-resolution" && /@oz\/contracts/.test(x.question))).toBe(true);
    expect(q.some((x) => x.raised_by === "dependency-acquisition" && /package_unpinned/.test(x.question))).toBe(true);
    expect(q.every((x) => x.epistemic === "unknown")).toBe(true);
  });

  it("deterministic: the same sealed input gives the same hash; the snapshot identity and the dependency manifest are part of it", () => {
    const a = build(); const b = build();
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/); expect(b.sha256).toBe(a.sha256); expect(b.json).toBe(a.json);
    expect(build({ snapshot: { ...SNAP, commit_sha: "c".repeat(40) }, dependencies: null }).sha256).not.toBe(a.sha256);
    expect(build(ctx({ manifest: MANIFEST, files: { "lib/dep": ["src/Lib.sol"] } })).sha256).not.toBe(a.sha256);
    expect(a.doc.base.sha256).toBe(buildProtocolModel(SOURCES).sha256); // it names the base model; it does not fork or change it
  });

  it("the base model is untouched: without a context the analysis computes exactly what it always did", () => {
    const plain = computeStructuralAnalysis(SOURCES); const shared = computeStructuralAnalysis(SOURCES, ctx());
    expect(plain.sharedModel).toBeUndefined();
    expect(shared.protocolModel).toEqual(plain.protocolModel); expect(shared.findings).toEqual(plain.findings);
    expect(shared.sharedModel).toMatchObject({ base_sha256: plain.protocolModel.sha256, sections: { state: "computed:derived", invariants: "not_computed" } });
  });

  it("reading is by hash: a document that does not match its hash, or lacks a section status, is refused", () => {
    const { json, sha256, doc } = build(); const base = doc.base.sha256;
    const read = verifySharedModel({ sha256, base_sha256: base, json });
    expect(read.sha256).toBe(sha256); expect(modelReadRecord(read, "test")).toEqual({ sha256, base_sha256: base, schema: SHARED_MODEL_SCHEMA, read: "by_hash", verified: "re-hashed on read", used_for: "test" });
    expect(() => verifySharedModel({ sha256, base_sha256: base, json: json.replace("Vault", "Vau1t") })).toThrow(/does not match the hash/);
    expect(() => verifySharedModel({ sha256: "0".repeat(64), base_sha256: base, json })).toThrow(/does not match the hash/);
    expect(modelReadRecord({ available: false, reason: "not stored" }, "x")).toEqual({ sha256: null, read: "unavailable", reason: "not stored" });
  });
});

describe("the lead key (C2)", () => {
  const a = { repository: "Acme/Vault", class: "reentrancy", file: "src/Vault.sol", contract: "Vault", function: "withdraw" };
  it("is the same for every engine and at every commit: no generator, snapshot or line is part of it", () => {
    expect(leadKey(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(leadKey({ ...a, repository: "acme/vault", function: "withdraw(uint256)" })).toBe(leadKey(a)); // Slither names a signature
    expect(leadKey({ ...a, contract: "Vault@src/Vault.sol", file: "./src/Vault.sol" })).toBe(leadKey(a));
    expect(normaliseFunction("Vault.withdraw(uint256,address)")).toBe("withdraw");
  });
  it("differs when the issue differs: another class, function, contract, file or repository", () => {
    const keys = [a, { ...a, class: "access-control" }, { ...a, function: "deposit" }, { ...a, contract: "Other" }, { ...a, file: "src/Other.sol" }, { ...a, repository: "acme/other" }, { ...a, function: "" }].map(leadKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
