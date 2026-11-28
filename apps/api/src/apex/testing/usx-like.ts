/**
 * The USX-LIKE test snapshot for the APEX shadow stage: SELF-AUTHORED contracts (usx-like/) placed at the 20 official in-scope paths of
 * USX, plus a few out-of-scope files (src/cloak/, test/, script/, package.json). They imitate only the shape of the protocol (a diamond with
 * facets and diamond storage, OFT adapters, an ERC-20 relayer, external calls); USX's source was not obtained or read. Nothing here is
 * tuned to USX: the fixtures exist to exercise abstention, suppression, scope restriction and recording.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGitFixture, type GitFixture } from "../../acquisition/testing/git-fixture.js";
import { synthGz } from "../../acquisition/testing/synth-archive.js";
import { APEX_SHADOW_TARGET } from "../shadow-target.js";

export const USX_LIKE_DIR = fileURLToPath(new URL("./usx-like/", import.meta.url));

export function usxLikeFiles(): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const walk = (d: string): void => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push({ path: relative(USX_LIKE_DIR, p).split("\\").join("/"), content: readFileSync(p, "utf8") }); } };
  walk(USX_LIKE_DIR);
  return [...out, { path: "package.json", content: "{\n  \"name\": \"usx-like-fixture\",\n  \"private\": true\n}\n" }];
}
export const usxLikeSources = () => usxLikeFiles().filter((f) => f.path.endsWith(".sol")).map((f) => ({ path: f.path, text: f.content }));

/** The official scope record as a targeted promotion would carry it (evidence = the recorded doc, hash = the official page's). */
export const usxScope = (overrides: Partial<{ programme: string; in_scope_paths: string[]; evidence: string; evidence_sha256: string }> = {}) => ({
  programme: APEX_SHADOW_TARGET.programme, in_scope_paths: [...APEX_SHADOW_TARGET.inScopePaths], evidence: "docs/research-runs/usx-scope-evidence.md", evidence_sha256: APEX_SHADOW_TARGET.evidenceSha256, ...overrides,
});

/**
 * A local git repository of the USX-like files, presented as scroll-tech/usx-contracts at the approved commit id. The tree, blob ids and
 * archive are real (built by git); only the commit id is the approved one, so the FakeSource / loopback GitHub serve the test snapshot
 * under the pinned commit. Nothing is fetched.
 */
export function usxLikeGitFixture(options: { commit?: string; files?: Array<{ path: string; content: string }> } = {}): GitFixture {
  const fx = buildGitFixture(options.files ?? usxLikeFiles(), { owner: "scroll-tech", repo: "usx-contracts" });
  const commitSha = options.commit ?? APEX_SHADOW_TARGET.commit;
  const pinned = { ...fx, commitSha, prefix: `scroll-tech-usx-contracts-${commitSha.slice(0, 7)}` };
  return { ...pinned, tarGz: synthGz(pinned) };
}
