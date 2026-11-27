import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stand-ins for the pinned audit tools in tests. The Slither stand-in prints the RECORDED output of the real Slither 0.11.3 run on
 * eval/dev/contracts (laid out as contracts/*.sol, solc 0.8.28, absolute paths normalised), so the loop can be tested deterministically
 * without the tool installed. Failure modes reproduce each explicit failure state.
 */
export const SLITHER_FIXTURE = fileURLToPath(new URL("./slither-0.11.3-dev-contracts.json", import.meta.url));
export type FakeMode = "ok" | "compile_error" | "garbage" | "hang" | "old_version" | "crash";

export function fakeTools(mode: FakeMode = "ok"): { slither: string; solc: string; forge: (results: "pass" | "fail") => string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentsmith-fake-tools-"));
  const write = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
  const version = mode === "old_version" ? "0.10.0" : "0.11.3";
  const run = {
    ok: `cat '${SLITHER_FIXTURE}'; exit 255`,
    compile_error: `echo '{"success": false, "error": "Invalid compilation: missing import", "results": {}}'; exit 1`,
    garbage: `echo 'Traceback (most recent call last): not json'; exit 0`,
    hang: `sleep 30`,
    old_version: `cat '${SLITHER_FIXTURE}'`,
    crash: `echo 'segfault' >&2; exit 139`,
  }[mode];
  const slither = write("slither", `if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\n${run}`);
  const solc = write("solc", `echo 'solc, the solidity compiler commandline interface'; echo 'Version: 0.8.28+commit.7893614a.Linux.g++'`);
  const forge = (results: "pass" | "fail") => write(`forge-${results}`, `if [ "$1" = "--version" ]; then echo 'forge Version: 1.5.1-stable'; exit 0; fi
echo '{"test/Repro.t.sol:Repro": {"test_results": {"test_repro()": {"status": "${results === "pass" ? "Success" : "Failure"}", "reason": ${results === "pass" ? "null" : '"assertion failed"'}}}}}'`);
  return { slither, solc, forge, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
