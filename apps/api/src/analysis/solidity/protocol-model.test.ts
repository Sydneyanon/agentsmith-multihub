import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessCoverage } from "../../priority/coverage.js";
import { buildStructuralMap } from "./pipeline.js";
import { buildProtocolModel, coverageComponents } from "./protocol-model.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const VAULT = `pragma solidity ^0.8.20;
abstract contract Upgradable {
  address public implementation;
  function upgradeAndRun(address next, bytes calldata data) external {
    _authorize(next);
    implementation = next;
    (bool ok, ) = next.delegatecall(data);
    require(ok);
  }
  function _authorize(address next) internal virtual;
}
contract Vault is Upgradable {
  address public owner;
  mapping(address => uint256) public balances;
  modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }
  constructor() { owner = msg.sender; }
  function deposit() external payable { _credit(msg.sender, msg.value); }
  function _credit(address who, uint256 amt) internal { balances[who] += amt; }
  function withdraw(uint256 amt) external { (bool ok, ) = msg.sender.call{value: amt}(""); require(ok); balances[msg.sender] -= amt; }
  function rescue(address payable to) external onlyOwner { to.transfer(address(this).balance); }
  function _authorize(address) internal view override { require(msg.sender == owner, "owner"); }
  function slot() external view returns (bytes32 s) { assembly { s := sload(0) } }
}`;
const TOKEN = `pragma solidity ^0.8.20;
contract Token { mapping(address => uint256) public bal; function mint(address to, uint256 a) external { bal[to] += a; } }`;
const src = [{ path: "contracts/Vault.sol", text: VAULT }, { path: "contracts/Token.sol", text: TOKEN }];

describe("protocol model P1 (deterministic, evidence-backed export of what the analyzer knows)", () => {
  const { model, sha256, json } = buildProtocolModel(src);

  it("is deterministic and independent of source order; the hash is the hash of the stored JSON", () => {
    expect(buildProtocolModel(src).sha256).toBe(sha256);
    expect(buildProtocolModel([...src].reverse()).sha256).toBe(sha256);
    expect(sha(json)).toBe(sha256); expect(model.schema).toBe("protocol-model/1");
  });

  it("every fact cites code: its file hash equals the file's content hash and its lines exist", () => {
    const files = new Map(src.map((s) => [s.path, { sha: sha(s.text), lines: s.text.split("\n").length }]));
    const facts = [...model.components, ...model.functions, ...model.callEdges, ...model.inheritance];
    expect(facts.length).toBeGreaterThan(10);
    for (const f of facts) {
      const file = files.get(f.evidence.file)!; expect(file).toBeTruthy();
      expect(f.evidence.fileSha256).toBe(file.sha); expect(f.evidence.lineStart).toBeGreaterThanOrEqual(1); expect(f.evidence.lineEnd).toBeLessThanOrEqual(file.lines);
      expect(f.derivation).toMatch(/^(syntactic|inferred:[a-z-]+)$/);
    }
  });

  it("describes each deployable contract in its own dispatch context: inherited entry points, the override that is reached, and who declared what", () => {
    const up = model.functions.find((f) => f.id === "Vault.upgradeAndRun(address,bytes)")!;
    expect(up).toMatchObject({ component: "Vault", declaredIn: "Upgradable", entryPoint: true, callerGuarded: true });
    expect(model.inheritance.find((i) => i.component === "Vault")!.linearization).toEqual(["Vault", "Upgradable"]);
    // the abstract base is a component but its functions are described only through the deployed contract
    expect(model.components.some((c) => c.id === "Upgradable" && !c.deployable)).toBe(true);
    expect(model.functions.some((f) => f.component === "Upgradable")).toBe(false);
    const w = model.functions.find((f) => f.id === "Vault.withdraw(uint256)")!;
    expect(w).toMatchObject({ entryPoint: true, callerGuarded: false, stateWrites: ["balances"] });
  });

  it("records call edges with their kind and where the target comes from: internal helpers, modifiers, low-level calls, delegatecall", () => {
    const from = (id: string) => model.callEdges.filter((e) => e.from === id);
    expect(from("Vault.deposit()").some((e) => e.kind === "internal" && e.to === "Vault._credit")).toBe(true);
    expect(from("Vault.rescue(address payable)").some((e) => e.kind === "modifier" && e.to === "Vault.onlyOwner")).toBe(true);
    expect(from("Vault.withdraw(uint256)").find((e) => e.kind === "low-level-call")).toMatchObject({ targetProvenance: "msg.sender" });
    expect(from("Vault.upgradeAndRun(address,bytes)").find((e) => e.kind === "delegatecall")).toMatchObject({ targetProvenance: "param" });
  });

  it("lists what it could not model instead of dropping it", () => {
    // the assembly is in a view function (not an entry point) but still part of the described surface
    expect(model.functions.some((f) => f.id === "Vault.slot()")).toBe(true);
    expect(model.unknowns.some((u) => /assembly/.test(u.what) && u.file === "contracts/Vault.sol")).toBe(true);
  });

  it("a change to one file changes only that component's content hash", () => {
    const changed = buildProtocolModel([src[0]!, { path: "contracts/Token.sol", text: TOKEN.replace("+= a", "+= a * 2") }]).model;
    const h = (m: typeof model, id: string) => m.components.find((c) => c.id === id)!.contentSha256;
    expect(h(changed, "Token")).not.toBe(h(model, "Token"));
    expect(h(changed, "Vault")).toBe(h(model, "Vault")); expect(h(changed, "Upgradable")).toBe(h(model, "Upgradable"));
  });

  it("component hashes cover the component's own source: changing one contract leaves another contract in the same file unchanged", () => {
    const two = `pragma solidity ^0.8.20;\ncontract A { uint256 public x; function setX(uint256 v) external { x = v; } }\ncontract B { uint256 public y; function setY(uint256 v) external { y = v; } }`;
    const m1 = buildProtocolModel([{ path: "contracts/AB.sol", text: two }]).model;
    const m2 = buildProtocolModel([{ path: "contracts/AB.sol", text: two.replace("y = v;", "y = v + 1;") }]).model;
    const h = (m: typeof m1, id: string) => m.components.find((c) => c.id === id)!.contentSha256;
    expect(h(m2, "B")).not.toBe(h(m1, "B")); expect(h(m2, "A")).toBe(h(m1, "A"));
  });

  it("is in canonical order (sorted functions, call edges and unknowns), so equal models are byte-identical", () => {
    const key = (e: (typeof model.callEdges)[number]) => `${e.from}\u0000${e.kind}\u0000${e.to}\u0000${e.evidence.file}:${e.evidence.lineStart}`;
    const sorted = <T>(xs: T[], k: (x: T) => string) => xs.every((x, i) => i === 0 || k(xs[i - 1]!) <= k(x));
    expect(sorted(model.callEdges, key)).toBe(true); expect(sorted(model.functions, (f) => f.id)).toBe(true);
  });

  it("the structural map is a projection of the model (one derivation), consistent with it", () => {
    const map = buildStructuralMap(src);
    expect(map.protocol_model_schema).toBe("protocol-model/1");
    const vault = map.contracts.find((c) => c.name === "Vault")!;
    expect(vault.functions.map((f) => f.name).sort()).toEqual(model.functions.filter((f) => f.component === "Vault").map((f) => f.name).sort());
  });
});

describe("P1 consumer: Priority Engine coverage units come from the model (version-aware, per component)", () => {
  const CLASSES = ["reentrancy", "access-control"];
  it("research at a component's old content hash does not cover its new version; untouched components stay covered", () => {
    const before = buildProtocolModel(src).model; const units = coverageComponents(before);
    expect(units.map((u) => u.id).sort()).toEqual(["contracts/Token.sol#Token", "contracts/Vault.sol#Vault"]);
    expect(units.find((u) => u.id.endsWith("#Vault"))!.weight).toBe(4); // deposit, withdraw, rescue, upgradeAndRun
    const records = units.map((u) => ({ componentId: u.id, contentSha256: u.contentSha256, commitSha: "a".repeat(40), classesExamined: CLASSES, method: "structural" as const, recordedAt: "2026-11-26T00:00:00Z" }));
    const after = coverageComponents(buildProtocolModel([src[0]!, { path: "contracts/Token.sol", text: TOKEN.replace("+= a", "+= a * 2") }]).model);
    const p = assessCoverage(after, records, [], CLASSES);
    expect(p.changedSinceResearch).toEqual(["contracts/Token.sol#Token"]);
    expect(p.components.find((c) => c.id.endsWith("#Vault"))!.status).toBe("researched-at-current-version");
  });
});

describe("P1 on the development corpus: every contract is described and the model is stable", () => {
  const dev = join(__dirname, "..", "..", "..", "..", "..", "eval", "dev", "contracts");
  const files = readdirSync(dev).sort().map((f) => ({ path: `contracts/${f}`, text: readFileSync(join(dev, f), "utf8") }));
  it("describes every non-interface contract, with at least one entry point per deployable contract that has state-changing externals", () => {
    const { model, sha256 } = buildProtocolModel(files);
    expect(buildProtocolModel(files).sha256).toBe(sha256);
    expect(model.components.length).toBeGreaterThan(5);
    for (const c of model.components.filter((x) => x.deployable)) expect(c.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(model.functions.filter((f) => f.entryPoint).length).toBeGreaterThan(10);
  });
});
