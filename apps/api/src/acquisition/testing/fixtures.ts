import type { FixtureFile } from "./git-fixture.js";

export const SECRET_MARKER = "UNIQUE-CONTENT-MARKER-4f1c";

/** A repository that contains one of everything the acquisition must account for. */
export const MAIN_FILES: FixtureFile[] = [
  { path: "contracts/Vault.sol", content: `// ${SECRET_MARKER}\npragma solidity ^0.8.20;\ncontract Vault {\n  function withdraw() external {}\n}\n` },
  { path: "contracts/Token.sol", content: "pragma solidity ^0.8.20;\ncontract Token {}\n" },
  { path: "test/Vault.t.sol", content: "contract VaultTest {}\n" },
  { path: "README.md", content: "# Vault\n" },
  { path: "foundry.toml", content: "[profile.default]\nsrc = 'contracts'\n" },
  { path: "lib/forge-std/Test.sol", content: "contract Test {}\n" },
  { path: "big.txt", content: Buffer.alloc(300_000, 65) },
  { path: "image.bin", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) },
  { path: "latin1.txt", content: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) },
  { path: "link", symlink: "contracts/Vault.sol" },
  { path: "evil-link", symlink: "/etc/passwd" },
  { path: "up-link", symlink: "../../outside" },
  { path: "deps/lib", submodule: "2222222222222222222222222222222222222222" },
  { path: ".gitmodules", content: '[submodule "lib"]\n\tpath = deps/lib\n\turl = https://example.invalid/some/lib.git\n' },
  { path: "assets/model.bin", content: `version https://git-lfs.github.com/spec/v1\noid sha256:${"b".repeat(64)}\nsize 987654\n` },
  { path: "A.sol", content: "// upper\n" },
  { path: "a.sol", content: "// lower\n" },
  { path: "empty.txt", content: "" },
];
