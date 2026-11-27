import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMachines, type Fleet } from "./fleet-plan.js";
import { checkRelease, gitInRepo, type Git, type Release } from "./release-check.js";

const D = (n: string) => `registry.fly.io/agentsmith-hub@sha256:${n.repeat(64).slice(0, 64)}`;
const fleet: Fleet = { app: "agentsmith-hub", region: "syd", machines: [
  { name: "api", role: "api", processGroup: "app", managedBy: "fly deploy", gate: "deploy" },
  { name: "collector", role: "job", schedule: "hourly", cmd: ["collect.js"], gate: "deploy" },
  { name: "worker", role: "worker", restart: "always", cmd: ["worker.js"], gate: "worker activation", requires: ["R1"] },
] };
const m = (id: string, name: string, image: string, revision: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, name, state: "started", config: { image, ...extra }, image_ref: { labels: revision ? { "org.opencontainers.image.revision": revision } : {} } });
const release = (approved: boolean): Release => ({
  candidate: { commit: "c".repeat(40), image: D("a"), migrations: ["0001", "0012"] },
  approved: approved ? { commit: "c".repeat(40), image: D("a"), approved_on: "2026-11-27" } : null,
  critical_fixes: [{ commit: "fix1", what: "the citation root cause" }],
});
// a tiny fake history: new = has fix1; old = does not
const git: Git = { isAncestor: (a, d) => (a === "fix1" ? (d === "new" ? true : d === "old" ? false : null) : a === "c".repeat(40) ? d === "main-with" : null) };
const kinds = (f: ReturnType<typeof checkRelease>) => f.map((x) => `${x.kind}${x.machine ? `:${x.machine}` : ""}`);

describe("release check (read-only drift detection)", () => {
  it("a fully converged, approved fleet with all migrations is clean", () => {
    const actual = parseMachines([m("1", "api", D("a"), "new"), m("2", "collector", D("a"), "new", { schedule: "hourly", init: { cmd: ["collect.js"] } }), m("3", "worker", D("a"), "new", { init: { cmd: ["worker.js"] } })]);
    expect(checkRelease(release(true), fleet, actual, git, { engineStatus: { schema: { applied: ["0001_initial.sql", "0012_x.sql"] } }, mainRef: "main-with" })).toEqual([]);
  });

  it("catches today's production shape: API and collector on different revisions, behind the release, a critical fix missing, migrations and jobs missing", () => {
    const actual = parseMachines([m("1", "api", D("b"), "new"), m("2", "collector", D("c"), "old", { schedule: "hourly", init: { cmd: ["collect.js"] } })]);
    const f = checkRelease(release(false), fleet, actual, git, { engineStatus: { schema: { applied: ["0001_initial.sql"] } }, mainRef: "main-without" });
    expect(kinds(f)).toEqual(["unapproved_release", "version_mismatch", "behind_release:api", "behind_release:collector", "missing_machine:worker", "critical_fix_missing:collector", "missing_migration", "release_not_on_main"]);
    expect(f.find((x) => x.kind === "behind_release" && x.machine === "collector")!.command).toBe(`fly machine update 2 --app agentsmith-hub --image ${D("a")} --yes`);
    expect(f.find((x) => x.kind === "missing_migration")!.detail).toMatch(/0012/);
  });

  it("an image without a revision label, or with a revision outside this history, is reported, never assumed current", () => {
    const actual = parseMachines([m("1", "api", D("a"), null), m("2", "collector", D("a"), "elsewhere", { schedule: "hourly", init: { cmd: ["collect.js"] } })]);
    const f = checkRelease(release(true), { ...fleet, machines: fleet.machines.slice(0, 2) }, actual, git, {});
    expect(kinds(f)).toEqual(["unidentified_image:api", "unidentified_image:collector", "migrations_unchecked"]);
  });

  it("the committed release record is well-formed and names commits that exist, including every critical fix", () => {
    const root = join(__dirname, "..");
    const r = JSON.parse(readFileSync(join(root, "deploy", "release.json"), "utf8")) as Release;
    expect(r.candidate.image).toMatch(/^registry\.fly\.io\/agentsmith-hub@sha256:[0-9a-f]{64}$/);
    expect(r.candidate.commit).toMatch(/^[0-9a-f]{40}$/);
    const g = gitInRepo(root);
    for (const f of r.critical_fixes) expect(g.isAncestor(f.commit, r.candidate.commit), `${f.commit} in candidate`).toBe(true);
    expect(r.candidate.migrations).toEqual(expect.arrayContaining(["0012", "0013", "0014"]));
  });
});
