import { AcquisitionError } from "../errors.js";
import type { GitTree, OpenedArchive, RepositoryIdentity, RepositorySource, ResolvedCommit, TreeEntry } from "../github-source.js";
import type { GitFixture } from "./git-fixture.js";

/** A stand-in for GitHub backed by a real local git fixture. Every field can be tampered with to simulate a fault. */
export class FakeSource implements RepositorySource {
  identity: RepositoryIdentity;
  refs: Record<string, string> = {};
  commitSha: string;
  treeSha: string;
  treeEntries: TreeEntry[];
  treeTruncated = false;
  treeShaOverride: string | null = null;
  tarGz: Buffer;
  chunkSize = 16 * 1024;
  archiveError: Error | null = null;
  /** The archive request never answers until the caller aborts it (simulates a stalled download). */
  hang = false;
  calls: string[] = [];

  constructor(public fixture: GitFixture, identity: Partial<RepositoryIdentity> = {}) {
    this.identity = { repositoryId: 1234, fullName: `${fixture.owner}/${fixture.repo}`, defaultBranch: "main", archived: false, fork: false, ...identity };
    this.refs = { main: fixture.commitSha, HEAD: fixture.commitSha };
    this.commitSha = fixture.commitSha; this.treeSha = fixture.treeSha;
    this.treeEntries = fixture.treeEntries; this.tarGz = fixture.tarGz;
  }

  async getRepository(): Promise<RepositoryIdentity> { this.calls.push("repo"); return this.identity; }
  async resolveCommit(_o: string, _r: string, ref: string | undefined): Promise<ResolvedCommit> {
    this.calls.push(`commit:${ref ?? "HEAD"}`);
    const key = ref ?? "HEAD";
    const sha = /^[a-f0-9]{40}$/.test(key) ? key : this.refs[key];
    if (!sha || (sha !== this.commitSha)) throw new AcquisitionError("commit_unavailable", "the commit does not exist");
    return { commitSha: sha, treeSha: this.treeSha };
  }
  async getTree(): Promise<GitTree> { this.calls.push("tree"); return { sha: this.treeShaOverride ?? this.treeSha, truncated: this.treeTruncated, entries: this.treeEntries }; }
  async openArchive(_o: string, _r: string, commitSha: string, signal?: AbortSignal): Promise<OpenedArchive> {
    this.calls.push(`archive:${commitSha}`);
    if (this.hang) await new Promise<void>((_resolve, reject) => { signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    if (this.archiveError) throw this.archiveError;
    const data = this.tarGz; const size = this.chunkSize;
    return { finalHost: "codeload.github.com", body: (async function* () { for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size); })() };
  }
}
