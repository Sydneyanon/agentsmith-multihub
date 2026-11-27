/**
 * Release and drift check (read-only). Part of every release: run it before asking for deploy approval and again after each
 * production step. It NEVER changes anything.
 *
 * It compares production with deploy/release.json (the one release baseline) and deploy/fleet.json (the desired fleet) and reports:
 *   version_mismatch      machines of the app run different images (e.g. API and collector on different revisions)
 *   behind_release        a machine does not run the release image (with the exact converge command, via fleet-plan)
 *   critical_fix_missing  a running revision does not contain a fix listed as critical in release.json
 *   unidentified_image    a running image carries no revision label, so its content cannot be checked
 *   missing_migration     the release ships migrations production has not applied (from /v1/engine/status, if supplied)
 *   missing_machine       a declared scheduled job or worker is not running (and the approval it needs)
 *   config_drift / unexpected   as in fleet-plan
 *   release_not_on_main   the release commit is not on the repository's main branch (production runs code main does not have)
 *   unapproved_release    release.json has a candidate the owner has not yet approved (informational until approved)
 *
 *   FLY_API_TOKEN=... npx tsx scripts/release-check.ts [--machines saved.json] [--engine-status status.json] [--main <ref>]
 * Exit 0: production matches an approved release. 1: drift or pending approval. 2: usage error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMachines, planFleet, type Actual, type Fleet } from "./fleet-plan.js";

export type Release = {
  candidate: { commit: string; image: string; migrations: string[]; smoke?: string; analyzer?: string };
  approved: { commit: string; image: string; approved_on: string } | null;
  critical_fixes: Array<{ commit: string; what: string }>;
};
export type EngineStatus = { schema?: { applied?: string[] | null } } | null;
export type Finding = { kind: string; machine: string | null; detail: string; command: string | null; gate: string | null };
export type Git = { isAncestor(ancestor: string, descendant: string): boolean | null };

const digestOf = (image: string) => /@(sha256:[0-9a-f]{64})/.exec(image)?.[1] ?? image;

export function checkRelease(release: Release, fleet: Fleet, actual: Actual[], git: Git, opts: { engineStatus?: EngineStatus; mainRef?: string | null } = {}): Finding[] {
  const out: Finding[] = [];
  const target = release.approved?.image ?? release.candidate.image;
  if (!release.approved || release.approved.image !== release.candidate.image)
    out.push({ kind: "unapproved_release", machine: null, detail: `candidate ${release.candidate.commit.slice(0, 7)} (${digestOf(release.candidate.image).slice(0, 19)}…) is not approved for production`, command: null, gate: "owner approval" });

  const declared = new Set(fleet.machines.map((m) => m.name));
  const running = actual.filter((a) => declared.has(a.name));
  const images = new Map<string, string[]>();
  for (const a of running) images.set(digestOf(a.image), [...(images.get(digestOf(a.image)) ?? []), a.name]);
  if (images.size > 1)
    out.push({ kind: "version_mismatch", machine: null, detail: [...images.entries()].map(([d, ns]) => `${ns.join(", ")} on ${d.slice(0, 19)}…`).join(" | "), command: null, gate: null });

  for (const c of planFleet(fleet, actual, target)) {
    const kind = c.kind === "image_drift" ? "behind_release" : c.kind === "missing" ? "missing_machine" : c.kind;
    out.push({ kind, machine: c.machine, detail: `${c.detail}${c.requires.length ? `; requires: ${c.requires.join(", ")}` : ""}`, command: c.command, gate: c.gate });
  }

  for (const a of running) {
    if (!a.revision) { out.push({ kind: "unidentified_image", machine: a.name, detail: `image ${digestOf(a.image).slice(0, 19)}… has no revision label`, command: null, gate: null }); continue; }
    for (const f of release.critical_fixes) {
      const has = git.isAncestor(f.commit, a.revision);
      if (has === false) out.push({ kind: "critical_fix_missing", machine: a.name, detail: `revision ${a.revision.slice(0, 7)} lacks ${f.commit.slice(0, 7)}: ${f.what}`, command: null, gate: "deploy" });
      if (has === null) out.push({ kind: "unidentified_image", machine: a.name, detail: `revision ${a.revision.slice(0, 7)} is not in this repository's history`, command: null, gate: null });
    }
  }

  const applied = opts.engineStatus?.schema?.applied;
  if (applied) {
    const names = applied.map((m) => m.slice(0, 4));
    const missing = release.candidate.migrations.filter((m) => !names.includes(m));
    if (missing.length) out.push({ kind: "missing_migration", machine: null, detail: `release ships ${missing.join(", ")}; production has not applied them`, command: "see docs/approval-request-final.md A3", gate: "production migration" });
  } else out.push({ kind: "migrations_unchecked", machine: null, detail: "no engine status supplied (--engine-status): applied migrations were not compared", command: null, gate: null });

  if (opts.mainRef) {
    const onMain = git.isAncestor(release.candidate.commit, opts.mainRef);
    if (onMain === false) out.push({ kind: "release_not_on_main", machine: null, detail: `release ${release.candidate.commit.slice(0, 7)} is not on ${opts.mainRef}: production would run code the main branch does not contain`, command: null, gate: "owner (merge to main)" });
  }
  return out;
}

export const gitInRepo = (cwd = process.cwd()): Git => ({
  isAncestor(a, d) {
    try { execFileSync("git", ["cat-file", "-e", `${a}^{commit}`], { cwd, stdio: "ignore" }); execFileSync("git", ["cat-file", "-e", `${d}^{commit}`], { cwd, stdio: "ignore" }); } catch { return null; }
    try { execFileSync("git", ["merge-base", "--is-ancestor", a, d], { cwd, stdio: "ignore" }); return true; } catch { return false; }
  },
});

if (process.argv[1]?.endsWith("release-check.ts")) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] ?? null : null; };
  const root = process.cwd();
  const release = JSON.parse(readFileSync(join(root, "deploy", "release.json"), "utf8")) as Release;
  const fleet = JSON.parse(readFileSync(join(root, "deploy", "fleet.json"), "utf8")) as Fleet;
  const m = arg("--machines");
  const raw = m ? readFileSync(m, "utf8") : execFileSync("fly", ["machines", "list", "--app", fleet.app, "--json"], { encoding: "utf8" });
  const es = arg("--engine-status");
  const findings = checkRelease(release, fleet, parseMachines(JSON.parse(raw)), gitInRepo(root), { engineStatus: es ? JSON.parse(readFileSync(es, "utf8")) : null, mainRef: arg("--main") ?? "origin/main" });
  console.log(`release candidate ${release.candidate.commit.slice(0, 12)} ${digestOf(release.candidate.image)}; approved: ${release.approved ? release.approved.commit.slice(0, 12) : "none"}`);
  for (const f of findings) console.log(`[${f.kind}]${f.machine ? ` ${f.machine}` : ""}: ${f.detail}${f.gate ? `\n    approval: ${f.gate}` : ""}${f.command ? `\n    ${f.command}` : ""}`);
  const blocking = findings.filter((f) => f.kind !== "migrations_unchecked");
  console.log(blocking.length ? `\n${blocking.length} item(s) need action` : "\nproduction matches the approved release");
  process.exit(blocking.length ? 1 : 0);
}
