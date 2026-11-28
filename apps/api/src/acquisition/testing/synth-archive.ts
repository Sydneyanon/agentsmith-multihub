import { END, dir, file, gz, paxHeader, symlink, tar } from "./tar-writer.js";
import type { GitFixture } from "./git-fixture.js";

const contentOf = (fixture: GitFixture, path: string): Buffer => {
  const f = fixture.files.find((x) => x.path === path);
  if (!f || !("content" in f)) throw new Error(`no content for ${path}`);
  return Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
};

/** Rebuilds the archive of a real fixture entry by entry, so a test can drop, add, alter or reorder precisely one thing. */
export function synthArchive(fixture: GitFixture, options: {
  comment?: string | null; drop?: string[]; extra?: Buffer[]; replace?: Record<string, Buffer>; prefix?: string; skipEnd?: boolean; skipPrefixDir?: boolean;
} = {}): Buffer {
  const prefix = options.prefix ?? fixture.prefix;
  const parts: Buffer[] = [];
  if (options.comment !== null) parts.push(paxHeader({ comment: options.comment ?? fixture.commitSha }, "g"));
  if (!options.skipPrefixDir) parts.push(dir(prefix));
  for (const entry of fixture.treeEntries) {
    if (options.drop?.includes(entry.path)) continue;
    const full = `${prefix}/${entry.path}`;
    if (entry.type === "tree" || entry.type === "commit") parts.push(dir(full));
    else if (entry.mode === "120000") { const link = fixture.files.find((x) => x.path === entry.path); parts.push(symlink(full, (link as { symlink: string }).symlink)); }
    else parts.push(file(full, options.replace?.[entry.path] ?? contentOf(fixture, entry.path)));
  }
  parts.push(...(options.extra ?? []));
  if (!options.skipEnd) parts.push(END);
  return tar(...parts);
}
export const synthGz = (fixture: GitFixture, options: Parameters<typeof synthArchive>[1] = {}): Buffer => gz(synthArchive(fixture, options));
