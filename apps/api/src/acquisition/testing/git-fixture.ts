import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { TreeEntry } from "../github-source.js";

/**
 * A REAL git repository built in a temporary directory, with the real `git archive` output and the real `git ls-tree` listing.
 * Tests therefore exercise genuine git object ids and genuine archive bytes, with no third-party host involved.
 */
export type FixtureFile =
  | { path: string; content: string | Buffer; mode?: "100644" | "100755" }
  | { path: string; symlink: string }
  | { path: string; submodule: string };

export type GitFixture = {
  owner: string; repo: string; commitSha: string; treeSha: string; prefix: string;
  tarGz: Buffer; tarball: Buffer; treeEntries: TreeEntry[]; files: FixtureFile[]; cleanup(): void;
};

const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2024-01-02T03:04:05Z", GIT_COMMITTER_DATE: "2024-01-02T03:04:05Z",
};

export function buildGitFixture(files: FixtureFile[], options: { owner?: string; repo?: string; message?: string } = {}): GitFixture {
  const owner = options.owner ?? "acme"; const repo = options.repo ?? "vault";
  const dirPath = mkdtempSync(join(tmpdir(), "agentsmith-fixture-"));
  const git = (...args: string[]): Buffer => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", ...args], { cwd: dirPath, env: ENV, maxBuffer: 512 * 1024 * 1024 });
  try {
    git("init", "-q", "-b", "main");
    for (const file of files) {
      if ("submodule" in file) continue;
      const full = join(dirPath, file.path);
      mkdirSync(dirname(full), { recursive: true });
      if ("symlink" in file) symlinkSync(file.symlink, full); else writeFileSync(full, file.content, { mode: file.mode === "100755" ? 0o755 : 0o644 });
    }
    git("add", "-A");
    for (const file of files) if ("submodule" in file) git("update-index", "--add", "--cacheinfo", `160000,${file.submodule},${file.path}`);
    git("commit", "-q", "--allow-empty", "-m", options.message ?? "fixture");
    const commitSha = git("rev-parse", "HEAD").toString().trim();
    const treeSha = git("rev-parse", "HEAD^{tree}").toString().trim();
    const prefix = `${owner}-${repo}-${commitSha.slice(0, 7)}`;
    const tarball = git("archive", "--format=tar", `--prefix=${prefix}/`, "HEAD");
    const listing = git("ls-tree", "-r", "-t", "-z", "--long", "HEAD").toString("utf8");
    const treeEntries: TreeEntry[] = [];
    for (const record of listing.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, type, sha, size] = record.slice(0, tab).split(/\s+/);
      treeEntries.push({ path: record.slice(tab + 1), mode: mode!, type: type as TreeEntry["type"], sha: sha!, ...(type === "blob" ? { size: Number(size) } : {}) });
    }
    return { owner, repo, commitSha, treeSha, prefix, tarGz: gzipSync(tarball), tarball, treeEntries, files, cleanup: () => rmSync(dirPath, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dirPath, { recursive: true, force: true });
    throw error;
  }
}
