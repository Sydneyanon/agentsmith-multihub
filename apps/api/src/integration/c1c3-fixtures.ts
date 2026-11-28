import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGitFixture, type FixtureFile, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { usxLikeFiles, usxLikeGitFixture } from "../apex/testing/usx-like.js";

/**
 * CONTROLLED FIXTURES for the C1-C3 demonstration (the integration test and scripts/c1-c3-rehearsal.ts). Everything here is self-authored
 * and local: no real repository is read or fetched. The repositories are built as real git repositories (real tree and blob ids) and
 * served by the loopback GitHub stand-in.
 *
 *  - PARENT: the self-authored USX-like snapshot (apex/testing/usx-like), served as scroll-tech/usx-contracts at the approved commit so
 *    the APEX shadow is eligible BY TEST CONFIGURATION ONLY, plus one demonstration contract outside the bounty scope, four submodule
 *    entries and the remapping files.
 *  - vault-lib: an available submodule (pinned by the parent tree), with its own nested submodule;
 *  - nested-lib: the nested submodule (depth 2), which itself pins a depth-3 submodule that is beyond the limit and never fetched.
 */
export const SHARED_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VaultMath} from "vault-lib/VaultMath.sol";

// Self-authored demonstration contract (outside the bounty scope). Two deliberate shapes:
//  - withdraw: the external call precedes the balance update;
//  - configure: the bootstrap pattern (open until an owner is set).
contract SharedVault {
    address public owner;
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
        balances[msg.sender] = 0;
    }

    function configure(address o) external {
        require(owner == address(0) || msg.sender == owner);
        owner = o;
    }
}
`;
const lineOf = (text: string, marker: string): number => { const i = text.split("\n").findIndex((l) => l.includes(marker)); if (i < 0) throw new Error(`marker not found: ${marker}`); return i + 1; };
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
export const SHARED_VAULT_PATH = "src/demo/SharedVault.sol";

const NESTED_PIN = "7".repeat(40);
export const PINS = { gitlab: "3".repeat(40), ghost: "4".repeat(40), noUrl: "5".repeat(40), deeper: NESTED_PIN };

export type DemoFixtures = { parent: GitFixture; vaultLib: GitFixture; nestedLib: GitFixture; all: GitFixture[]; cleanup(): void };
export function buildDemoFixtures(options: { commit?: string; shiftLines?: number } = {}): DemoFixtures {
  const nestedLib = buildGitFixture([
    { path: "src/Nested.sol", content: "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\nlibrary Nested { function one() internal pure returns (uint256) { return 1; } }\n" },
    { path: ".gitmodules", content: '[submodule "lib/deeper"]\n\tpath = lib/deeper\n\turl = https://github.com/acme-labs/deeper-lib\n' },
    { path: "lib/deeper", submodule: PINS.deeper },
  ], { owner: "acme-labs", repo: "nested-lib" });
  const vaultLib = buildGitFixture([
    { path: "src/VaultMath.sol", content: "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\nlibrary VaultMath { function half(uint256 x) internal pure returns (uint256) { return x / 2; } }\n" },
    { path: "README.md", content: "# vault-lib (self-authored fixture)\n" },
    { path: ".gitmodules", content: '[submodule "lib/nested-lib"]\n\tpath = lib/nested-lib\n\turl = git@github.com:acme-labs/nested-lib.git\n' },
    { path: "lib/nested-lib", submodule: nestedLib.commitSha },
  ], { owner: "acme-labs", repo: "vault-lib" });
  const vault = "\n".repeat(options.shiftLines ?? 0) + SHARED_VAULT;
  const files: FixtureFile[] = [
    ...usxLikeFiles().filter((f) => f.path !== "package.json"),
    { path: SHARED_VAULT_PATH, content: vault },
    { path: ".gitmodules", content: [
      '[submodule "lib/vault-lib"]', "\tpath = lib/vault-lib", "\turl = https://github.com/acme-labs/vault-lib",
      '[submodule "lib/gitlab-lib"]', "\tpath = lib/gitlab-lib", "\turl = https://gitlab.com/acme-labs/gitlab-lib.git",
      '[submodule "lib/ghost"]', "\tpath = lib/ghost", "\turl = https://github.com/acme-labs/ghost-lib.git",
      '[submodule "lib/unpinned"]', "\tpath = lib/unpinned", "\turl = https://github.com/acme-labs/unpinned-lib", ""].join("\n") },
    { path: "lib/vault-lib", submodule: vaultLib.commitSha },
    { path: "lib/gitlab-lib", submodule: PINS.gitlab },
    { path: "lib/ghost", submodule: PINS.ghost },
    { path: "lib/no-url", submodule: PINS.noUrl },
    { path: "remappings.txt", content: "vault-lib/=lib/vault-lib/src/\nghost/=lib/ghost/src/\n@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/\n" },
    { path: "foundry.toml", content: "[profile.default]\nsrc = 'src'\nlibs = ['lib']\nremappings = [\n  \"demo/=src/demo/\",\n]\n" },
    { path: "package.json", content: JSON.stringify({ name: "usx-like-fixture", private: true, dependencies: { "@openzeppelin/contracts": "5.0.2", "unpinned-pkg": "^1.0.0" } }, null, 2) + "\n" },
    { path: "package-lock.json", content: JSON.stringify({ name: "usx-like-fixture", lockfileVersion: 3, packages: { "": { name: "usx-like-fixture" },
      "node_modules/@openzeppelin/contracts": { version: "5.0.2", resolved: "https://registry.npmjs.org/@openzeppelin/contracts/-/contracts-5.0.2.tgz", integrity: "sha512-" + Buffer.alloc(64, 7).toString("base64") } } }, null, 2) + "\n" },
  ];
  const parent = usxLikeGitFixture({ files: files as Array<{ path: string; content: string }>, ...(options.commit ? { commit: options.commit } : {}) });
  const all = [parent, vaultLib, nestedLib];
  return { parent, vaultLib, nestedLib, all, cleanup: () => all.forEach((f) => f.cleanup()) };
}

/** A small second repository whose source imports a dependency that is NOT available: the Slither stage must abstain, naming it. */
export function buildBlockedFixture(): GitFixture {
  return buildGitFixture([
    { path: "src/Needs.sol", content: "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\nimport {Ghost} from \"ghost/Ghost.sol\";\nimport \"unpinned/Thing.sol\";\ncontract Needs { function f() external pure returns (uint256) { return 1; } }\n" },
    { path: ".gitmodules", content: '[submodule "lib/ghost"]\n\tpath = lib/ghost\n\turl = https://github.com/acme-labs/ghost-lib.git\n[submodule "lib/unpinned"]\n\tpath = lib/unpinned\n\turl = https://github.com/acme-labs/unpinned-lib\n' },
    { path: "lib/ghost", submodule: PINS.ghost },
    { path: "remappings.txt", content: "ghost/=lib/ghost/src/\nunpinned/=lib/unpinned/src/\n" },
  ], { owner: "acme-labs", repo: "blocked" });
}

/**
 * The Slither STAND-IN for the demonstration. It is a shell script that prints AUTHORED output in Slither's JSON shape for the demo
 * contract: it is NOT Slither and detects nothing. It exists to show the data flow (the shared model and remappings reaching the stage,
 * leads becoming hypotheses with the same lead key as the specialists'), which is all the demonstration claims.
 */
export const STANDIN_LABEL = "AUTHORED STAND-IN OUTPUT (not Slither's detection): a shell script printing fixed JSON in Slither's shape";
export function slitherStandIn(shiftLines = 0): { slither: string; solc: string; argsLog: string; cleanup(): void } {
  const text = "\n".repeat(shiftLines) + SHARED_VAULT;
  const fn = (name: string, first: string, last: string) => ({ type: "function", name, source_mapping: { filename_relative: SHARED_VAULT_PATH, lines: range(lineOf(text, first), lineOf(text, last)) }, type_specific_fields: { parent: { type: "contract", name: "SharedVault" }, signature: `${name}()` } });
  const out = { success: true, error: null, results: { detectors: [
    { check: "reentrancy-eth", impact: "High", confidence: "Medium", description: "Reentrancy in SharedVault.withdraw() (src/demo/SharedVault.sol): External calls: msg.sender.call{value: amount}() State variables written after the call(s): balances[msg.sender] = 0 [AUTHORED STAND-IN OUTPUT]",
      elements: [fn("withdraw", "function withdraw()", "balances[msg.sender] = 0;")] },
    { check: "protected-vars", impact: "High", confidence: "High", description: "SharedVault.configure(address) (src/demo/SharedVault.sol) should have a caller check protecting owner [AUTHORED STAND-IN OUTPUT]",
      elements: [fn("configure", "function configure(address o)", "owner = o;")] },
    { check: "solc-version", impact: "Informational", confidence: "High", description: "Pragma version^0.8.20 [AUTHORED STAND-IN OUTPUT]", elements: [] },
  ] } };
  const dir = mkdtempSync(join(tmpdir(), "agentsmith-c1c3-standin-"));
  const write = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
  writeFileSync(join(dir, "demo.json"), JSON.stringify(out));
  const argsLog = join(dir, "args.log");
  // answers --version; records its arguments and whether the dependency source is on disk; prints the authored output for the demo directory only
  const slither = write("slither", `if [ "$1" = "--version" ]; then echo 0.11.3; exit 0; fi
printf '%s\\n' "$*" >> '${argsLog}'
if [ -f lib/vault-lib/src/VaultMath.sol ]; then echo "dependency-source-present" >> '${argsLog}'; fi
if [ "$1" = "src/demo" ]; then cat '${join(dir, "demo.json")}'; else echo '{"success": true, "error": null, "results": {}}'; fi
exit 0`);
  const solc = write("solc", `echo 'solc, the solidity compiler commandline interface'; echo 'Version: 0.8.28+commit.7893614a.Linux.g++'`);
  return { slither, solc, argsLog, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
