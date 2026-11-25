// Derives the staging Fly configs from fly.toml so the three files cannot drift.
//   npm run staging:configs        rewrites fly.staging.toml and fly.staging-bootstrap.toml
// fly.toml names the existing app and is never used for staging. These files name the staging app.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE_HEADER = [
  "# This names the existing app. Never deploy with this file without an explicit",
  "# `--app <name>`; staging must use its own app (see docs/runtime-and-verification.md).",
  'app = "agentsmith-multihub"',
].join("\n");
const GROUPS_COMMENT = [
  "# Two process groups from the same image. The worker has no HTTP service, so Fly",
  "# never auto-stops it; its machine count is set at deploy time, not in this file.",
].join("\n");
const BOOTSTRAP_GROUPS_COMMENT = [
  "# One process group (app) for the first release. The worker group is added by a later",
  "# release with fly.staging.toml, once a database is attached and migrated.",
].join("\n");
const WORKER_PROCESS = '  worker = "npm run worker:intake"\n';
const WORKER_VM = '\n[[vm]]\n  processes = ["worker"]\n  memory = "512mb"\n  cpu_kind = "shared"\n  cpus = 1\n';

function mustReplace(text: string, find: string, replacement: string, label: string): string {
  if (text.split(find).length !== 2) throw new Error(`fly.toml no longer contains exactly one ${label}; update scripts/staging-config.ts`);
  return text.replace(find, replacement);
}

const header = (note: string) => [
  "# GENERATED from fly.toml by `npm run staging:configs` (scripts/staging-config.ts). Do not edit.",
  "# STAGING ONLY: this names the staging app, never the existing one.",
  ...(note ? [note] : []),
  'app = "agentsmith-multihub-staging"',
].join("\n");

/** Full staging config: app and worker process groups. Used for the release that adds the worker. */
export function stagingFull(source: string): string {
  return mustReplace(source, SOURCE_HEADER, header(""), "app header block");
}

/**
 * First-release config: the app process group only, so no worker Machine is created
 * before a database exists (a first `fly deploy` starts a Machine for every group defined).
 */
export function stagingBootstrap(source: string): string {
  const full = mustReplace(source, SOURCE_HEADER, header("# FIRST RELEASE: app process group only, no worker (it needs a database)."), "app header block");
  const appOnly = mustReplace(mustReplace(full, WORKER_PROCESS, "", "worker process line"), WORKER_VM, "", "worker vm block");
  return mustReplace(appOnly, GROUPS_COMMENT, BOOTSTRAP_GROUPS_COMMENT, "process-groups comment");
}

const root = fileURLToPath(new URL("../", import.meta.url));
export const STAGING_FILES = { full: "fly.staging.toml", bootstrap: "fly.staging-bootstrap.toml" } as const;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const source = readFileSync(`${root}fly.toml`, "utf8");
  writeFileSync(`${root}${STAGING_FILES.full}`, stagingFull(source));
  writeFileSync(`${root}${STAGING_FILES.bootstrap}`, stagingBootstrap(source));
  process.stdout.write(`wrote ${STAGING_FILES.full} and ${STAGING_FILES.bootstrap}\n`);
}
