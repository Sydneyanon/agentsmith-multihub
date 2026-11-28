import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { outboundFetch } from "../../net/outbound.js";
import { DryRunViolation, inDryRun, withDryRun } from "../effects.js";
import { parseForgeJson, runForgeTest } from "./foundry.js";
import { loadToolHost, materialise, registerToolHost, runFixed } from "./run-tool.js";
import "./tool-host/register.js";
import { execFixed } from "./tool-host/exec.js";
import { parseSlitherJson, runSlither } from "./slither.js";
import { fakeTools, SLITHER_FIXTURE, type FakeMode } from "./testing/fake-tools.js";

const corpus = join(__dirname, "..", "..", "..", "..", "..", "eval", "dev", "contracts");
const files = readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n)) }));
const toolDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("agentsmith-tool-")).sort();
const made: Array<() => void> = []; afterAll(() => made.forEach((c) => c()));
const tools = (m: FakeMode = "ok") => { const t = fakeTools(m); made.push(t.cleanup); return t; };

describe("dry-run side-effect guard", () => {
  it("refuses network, subprocess and filesystem effects inside a dry run, and nothing outside it", async () => {
    const before = toolDirs();
    const net = withDryRun(() => outboundFetch("https://api.github.com/repos/a/b"));
    await expect(net.result).rejects.toBeInstanceOf(DryRunViolation); expect(net.attempts).toEqual([{ effect: "network", what: "fetch api.github.com" }]);
    const sub = withDryRun(() => runFixed("/bin/true", [], { cwd: "/", timeoutMs: 1000, home: "/tmp" }));
    await expect(sub.result).rejects.toThrow(/dry run: refused subprocess/);
    const fs = withDryRun(async () => materialise(files));
    await expect(fs.result).rejects.toThrow(/dry run: refused filesystem/);
    const t = tools();
    const tool = withDryRun(() => runSlither({ files, slitherBin: t.slither, solcBin: t.solc }));
    await expect(tool.result).rejects.toBeInstanceOf(DryRunViolation);
    expect(toolDirs()).toEqual(before); // no working directory was created
    expect(inDryRun()).toBe(false);
    expect((await runFixed("/bin/echo", ["x"], { cwd: "/", timeoutMs: 5000, home: "/tmp" })).stdout.trim()).toBe("x"); // outside: works
  });
  it("the guard follows async work started inside the dry run", async () => {
    const r = withDryRun(async () => { await new Promise((res) => setTimeout(res, 5)); return Promise.all([outboundFetch("https://example.org/")]); });
    await expect(r.result).rejects.toBeInstanceOf(DryRunViolation);
  });
});

describe("Slither runner (pinned 0.11.3)", () => {
  it("parses the recorded real output into structured detections with classes and locations", () => {
    const p = parseSlitherJson(readFileSync(SLITHER_FIXTURE, "utf8"));
    if ("code" in p) throw new Error(p.detail);
    expect(p.detections.length).toBe(47);
    const re = p.detections.find((d) => d.check === "reentrancy-eth")!;
    expect(re.bugClass).toBe("reentrancy"); expect(re.elements[0]!.file).toMatch(/^contracts\/.*\.sol$/); expect(re.elements[0]!.lines.length).toBeGreaterThan(0);
    expect(p.detections.find((d) => d.check === "solc-version")!.bugClass).toBeNull(); // informational: counted, never a lead
  });
  it("a successful run keeps the reproducibility record, and repeated runs are byte-identical", async () => {
    const t = tools();
    const a = await runSlither({ files, slitherBin: t.slither, solcBin: t.solc }); const b = await runSlither({ files, slitherBin: t.slither, solcBin: t.solc });
    if (!a.ok || !b.ok) throw new Error("expected success");
    expect(a).toMatchObject({ version: "0.11.3", solcVersion: "0.8.28", args: [["contracts", "--solc", "<solc>", "--json", "-", "--disable-color"]], exitCodes: [255] });
    expect(a.rawOutputSha256).toBe(b.rawOutputSha256); expect(a.inputManifestSha256).toBe(b.inputManifestSha256);
    expect(a.rawOutput).not.toContain(tmpdir()); // no machine-specific path in what is stored
  });
  it.each([
    ["old_version", "version_mismatch"], ["compile_error", "compile_failed"], ["garbage", "output_invalid"], ["crash", "crashed"],
  ] as const)("failure mode %s is the explicit state %s, never 'no findings'", async (mode, code) => {
    const t = tools(mode);
    const r = await runSlither({ files, slitherBin: t.slither, solcBin: t.solc });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.failure.code).toBe(code);
  });
  it("timeout and a missing binary are explicit too, and the working directory is always removed", async () => {
    const before = toolDirs();
    const t = tools("hang");
    const r = await runSlither({ files, slitherBin: t.slither, solcBin: t.solc, timeoutMs: 400 });
    expect(r.ok === false && r.failure.code).toBe("timeout");
    const m = await runSlither({ files, slitherBin: "/nonexistent/slither", solcBin: t.solc });
    expect(m.ok === false && m.failure.code).toBe("tool_unavailable");
    expect((await runSlither({ files: [], slitherBin: t.slither, solcBin: t.solc })).ok).toBe(false);
    expect(toolDirs()).toEqual(before);
  });
  it("the runner honours an overall time limit and an output size limit as explicit failures", async () => {
    const hang = tools("hang"); const before = toolDirs();
    const t = await runSlither({ files, slitherBin: hang.slither, solcBin: hang.solc, timeoutMs: 60_000, totalTimeoutMs: 500 });
    expect(t.ok === false && t.failure.code).toBe("timeout");
    const ok = tools("ok");
    const big = await runSlither({ files, slitherBin: ok.slither, solcBin: ok.solc, maxOutputBytes: 1024 });
    expect(big).toMatchObject({ ok: false, failure: { code: "output_invalid" } });
    expect(big.ok === false && big.failure.detail).toMatch(/exceeded 1024 bytes/);
    const fine = await runSlither({ files, slitherBin: ok.slither, solcBin: ok.solc, totalTimeoutMs: 60_000, maxOutputBytes: 16 * 1024 * 1024 });
    expect(fine.ok && fine.detections.length).toBe(47);
    expect(toolDirs()).toEqual(before);
  });
  it("a build without the tool host cannot start a process: the loader says so", async () => {
    registerToolHost(null);
    try {
      expect(() => loadToolHost()).toThrow(/not part of this build/);
      expect((await runFixed("/bin/echo", ["x"], { cwd: "/", timeoutMs: 5000, home: "/tmp" })).spawnError).toBe("TOOL_HOST_UNAVAILABLE");
      const r = await runSlither({ files, slitherBin: "/bin/true", solcBin: "/bin/true" }); expect(r.ok === false && r.failure.code).toBe("tool_unavailable");
    } finally { registerToolHost({ execFixed }); }
    const cfg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "..", "tsconfig.build.json"), "utf8")) as { exclude: string[] };
    expect(cfg.exclude).toContain("apps/api/src/**/tool-host/**");
  });
  it("refuses unsafe snapshot paths before writing anything", () => {
    expect(() => materialise([{ path: "../escape.sol", content: Buffer.from("x") }])).toThrow(/unsafe snapshot path/);
    expect(() => materialise([{ path: "/etc/x.sol", content: Buffer.from("x") }])).toThrow(/unsafe snapshot path/);
  });
});

describe.skipIf(!process.env["AGENTSMITH_SLITHER_BIN"] || !process.env["AGENTSMITH_SOLC_BIN"])("the REAL pinned Slither (runs only where it is installed)", () => {
  it("matches the recorded output and is reproducible", async () => {
    const a = await runSlither({ files, slitherBin: process.env["AGENTSMITH_SLITHER_BIN"]!, solcBin: process.env["AGENTSMITH_SOLC_BIN"]! });
    const b = await runSlither({ files, slitherBin: process.env["AGENTSMITH_SLITHER_BIN"]!, solcBin: process.env["AGENTSMITH_SOLC_BIN"]! });
    if (!a.ok || !b.ok) throw new Error(JSON.stringify(a));
    expect(a.rawOutputSha256).toBe(b.rawOutputSha256);
    const recorded = parseSlitherJson(readFileSync(SLITHER_FIXTURE, "utf8")); if ("code" in recorded) throw new Error("fixture");
    expect(a.detections.map((d) => d.check).sort()).toEqual(recorded.detections.map((d) => d.check).sort());
  }, 300_000);
});

describe("Foundry runner (T-202 evaluator: pinned, offline, multi-file tests, --match-test)", () => {
  const test = { files: [{ path: "test/Repro.t.sol", content: Buffer.from("// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Repro { function test_x() public {} }\n") }, { path: "test/Helpers.sol", content: Buffer.from("// helpers\n") }], matchTest: "test_x" };
  it("reports the matched test's result with the reproducibility record", async () => {
    const t = tools();
    const pass = await runForgeTest({ files, test, forgeBin: t.forge("pass"), solcBin: t.solc });
    expect(pass).toMatchObject({ ok: true, version: "1.5.1", results: [{ test: "test/Repro.t.sol:Repro::test_x()", passed: true, reason: null }] });
    if (pass.ok) { expect(pass.rawOutput).not.toContain(tmpdir()); expect(pass.testSha256).toMatch(/^[a-f0-9]{64}$/); }
    expect(await runForgeTest({ files, test, forgeBin: t.forge("fail"), solcBin: t.solc })).toMatchObject({ ok: true, results: [{ passed: false, reason: "assertion failed" }] });
  });
  it("refuses tests outside test/, a test overwriting a snapshot file, a bad match pattern, an unpinned forge; and is refused in a dry run", async () => {
    const t = tools();
    expect(await runForgeTest({ files, test: { ...test, files: [{ path: "src/Evil.t.sol", content: Buffer.from("x") }] }, forgeBin: t.forge("pass"), solcBin: t.solc })).toMatchObject({ ok: false, failure: { code: "input_invalid" } });
    expect(await runForgeTest({ files, test: { ...test, files: [{ path: "test/OnlyHelpers.sol", content: Buffer.from("x") }] }, forgeBin: t.forge("pass"), solcBin: t.solc })).toMatchObject({ ok: false, failure: { code: "input_invalid" } });
    expect(await runForgeTest({ files: [...files, { path: "test/Repro.t.sol", content: Buffer.from("x") }], test, forgeBin: t.forge("pass"), solcBin: t.solc })).toMatchObject({ ok: false, failure: { code: "input_invalid" } });
    expect(await runForgeTest({ files, test: { ...test, matchTest: "x; rm -rf /" }, forgeBin: t.forge("pass"), solcBin: t.solc })).toMatchObject({ ok: false, failure: { code: "input_invalid" } });
    expect(await runForgeTest({ files, test, forgeBin: t.forge("old"), solcBin: t.solc })).toMatchObject({ ok: false, failure: { code: "version_mismatch" } });
    await expect(withDryRun(() => runForgeTest({ files, test, forgeBin: t.forge("pass"), solcBin: t.solc })).result).rejects.toBeInstanceOf(DryRunViolation);
    expect(parseForgeJson("nope")).toMatchObject({ code: "output_invalid" });
  });
});
