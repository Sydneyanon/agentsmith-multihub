import { createHash, type Hash } from "node:crypto";

/**
 * Incremental git blob id: SHA-1 of "blob <size>\0" followed by the content. The size must be known up front (a tar header
 * and a tree entry both state it), and finish() fails if a different number of bytes was fed.
 */
export class GitBlobHasher {
  private readonly hash: Hash;
  private fed = 0;
  constructor(private readonly size: number) {
    this.hash = createHash("sha1").update(`blob ${size}\0`);
  }
  update(chunk: Buffer): void {
    this.fed += chunk.length;
    if (this.fed > this.size) throw new Error("more bytes than the declared size");
    this.hash.update(chunk);
  }
  finish(): string {
    if (this.fed !== this.size) throw new Error(`fed ${this.fed} bytes, declared ${this.size}`);
    return this.hash.digest("hex");
  }
}

export const gitBlobSha1 = (content: Buffer): string => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
