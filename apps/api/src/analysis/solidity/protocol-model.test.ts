import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessCoverage } from "../../priority/coverage.js";
import { scoringComponentsFromModel } from "../../priority/from-model.js";
import { scoreOpportunity } from "../../priority/score.js";
import { FIXTURES, NOW } from "../../priority/fixtures.js";
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

describe("P1: unresolved relationships are explicit and nothing is connected to a guess", () => {
  const text = `pragma solidity ^0.8.20;
interface IOracle { function price() external view returns (uint256); }
contract Feed { function price() external view returns (uint256) { return 1; } }
contract User {
  Feed public feed; IOracle public oracle;
  function useTyped() external { feed.price(); }
  function useInterface() external { oracle.price(); }
  function useMissing() external { helperThatDoesNotExist(1); }
}`;
  const { model } = buildProtocolModel([{ path: "contracts/U.sol", text }]);
  const from = (id: string) => model.callEdges.filter((e) => e.from === id);
  it("an unresolved internal call is an 'unresolved' edge of the calling function, with its location, and also an unknown", () => {
    const u = from("User.useMissing()").find((e) => e.kind === "unresolved")!;
    expect(u).toMatchObject({ to: "helperThatDoesNotExist", resolvedCallee: null, derivation: "inferred:trace-unresolved" });
    expect(u.evidence.lineStart).toBe(8);
    expect(model.unknowns.some((x) => /helperThatDoesNotExist/.test(x.what))).toBe(true);
    expect(model.callEdges.some((e) => e.kind === "internal" && /helperThatDoesNotExist/.test(e.to))).toBe(false);
  });
  it("an external call names its target expression; it is resolved to a snapshot contract only when the type says so", () => {
    const typed = from("User.useTyped()").find((e) => e.kind === "external")!;
    expect(typed.to).toBe("feed"); expect(typed.resolvedCallee).toBe("Feed.price");
    const iface = from("User.useInterface()").find((e) => e.kind === "external")!;
    expect(iface.to).toBe("oracle"); expect(iface.resolvedCallee).toBeNull(); // an interface is never "resolved" to some implementer
  });
});

describe("P1 consumer: priority SCORING takes its component input from the shared model", () => {
  it("changed code raises the unexplored share; unchanged researched code keeps its saturation, through the frozen v1 scorer", () => {
    const m1 = buildProtocolModel(src).model;
    const recs = scoringComponentsFromModel(m1, []).map((c) => ({ componentId: c.id, contentSha256: c.contentSha256, commitSha: "a".repeat(40), classesExamined: ["reentrancy"], method: "structural" as const, recordedAt: "2026-11-26T00:00:00Z" }));
    const before = scoringComponentsFromModel(m1, recs);
    expect(before.every((c) => c.researchedAtHashes.includes(c.contentSha256))).toBe(true);
    const m2 = buildProtocolModel([src[0]!, { path: "contracts/Token.sol", text: TOKEN.replace("+= a", "+= a * 2") }]).model;
    const after = scoringComponentsFromModel(m2, recs);
    expect(after.find((c) => c.id.endsWith("#Token"))!.researchedAtHashes).not.toContain(after.find((c) => c.id.endsWith("#Token"))!.contentSha256);
    expect(after.find((c) => c.id.endsWith("#Token"))!.classesExamined).toEqual([]);
    const s1 = scoreOpportunity({ ...FIXTURES.stale, components: before }, NOW); const s2 = scoreOpportunity({ ...FIXTURES.stale, components: after }, NOW);
    expect(s2.unexploredShare).toBeGreaterThan(s1.unexploredShare); expect(s2.score).toBeGreaterThan(s1.score);
  });
});

describe("P1: constructors and calls reached through helpers", () => {
  const text = `pragma solidity ^0.8.20;
contract Base { address public owner; constructor() { owner = msg.sender; } }
contract Pay is Base {
  mapping(address => uint256) public owed;
  constructor() { owed[msg.sender] = 1; }
  function withdraw() external { _pay(msg.sender, owed[msg.sender]); owed[msg.sender] = 0; }
  function _pay(address to, uint256 a) internal { (bool ok, ) = to.call{value: a}(""); require(ok); }
}`;
  const { model } = buildProtocolModel([{ path: "contracts/P.sol", text }]);
  it("every constructor in the linearisation is described (it sets authority) and none is an entry point", () => {
    const ctors = model.functions.filter((f) => f.component === "Pay" && f.kind === "constructor");
    expect(ctors.map((c) => c.declaredIn).sort()).toEqual(["Base", "Pay"]);
    expect(ctors.every((c) => !c.entryPoint)).toBe(true);
    expect(ctors.find((c) => c.declaredIn === "Base")!.stateWrites).toEqual(["owner"]);
  });
  it("an entry point's reachable calls include those its internal helpers make on its behalf, attributed to the helper", async () => {
    const { reachableCalls } = await import("./protocol-model.js");
    const direct = model.callEdges.filter((e) => e.from === "Pay.withdraw()" && e.kind === "low-level-call");
    expect(direct).toHaveLength(0); // the call is made by the helper ...
    const reach = reachableCalls(model, "Pay.withdraw()");
    expect(reach.map((e) => [e.from, e.kind, e.targetProvenance])).toEqual([["Pay._pay", "low-level-call", "msg.sender"]]); // ... reached by withdraw, with the helper parameter traced back to its argument (msg.sender)
    const map = buildStructuralMap([{ path: "contracts/P.sol", text }]);
    expect(map.contracts.find((c) => c.name === "Pay")!.functions.find((f) => f.name === "withdraw")!.external_calls).toBe(1);
  });
});
