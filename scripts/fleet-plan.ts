/**
 * Read-only fleet plan: compares deploy/fleet.json with the machines Fly is actually running and prints, for each difference, the
 * exact command that would converge it and the approval it needs. It NEVER executes anything.
 *
 *   FLY_API_TOKEN=... npx tsx scripts/fleet-plan.ts <target image ref, e.g. registry.fly.io/agentsmith-hub@sha256:...>
 *   npx tsx scripts/fleet-plan.ts <target> --machines machines.json   (offline: a saved `fly machines list --json`)
 *
 * Exit 0 when the fleet matches, 1 when changes are needed (so it can gate a release checklist), 2 on usage errors.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Desired = { name: string; role: "api" | "job" | "worker"; processGroup?: string; schedule?: string; restart?: string; cmd?: string[];
  env?: Record<string, string>; secrets?: string[]; gate: string; requires?: string[]; managedBy?: string };
export type Fleet = { app: string; region: string; machines: Desired[] };
export type Actual = { id: string; name: string; state: string; image: string; schedule: string | null; cmd: string[] | null; env: Record<string, string> };
export type Change = { machine: string; kind: "missing" | "image_drift" | "config_drift" | "unexpected"; detail: string; gate: string; requires: string[]; command: string | null };

const digestOf = (image: string) => /@(sha256:[0-9a-f]{64})/.exec(image)?.[1] ?? image;

export function planFleet(fleet: Fleet, actual: Actual[], targetImage: string): Change[] {
  const out: Change[] = []; const byName = new Map(actual.map((a) => [a.name, a]));
  const A = `--app ${fleet.app}`;
  for (const d of fleet.machines) {
    const a = byName.get(d.name); const req = d.requires ?? [];
    if (!a) {
      if (d.role === "api") { out.push({ machine: d.name, kind: "missing", detail: "API machine not found", gate: d.gate, requires: req, command: null }); continue; }
      const env = Object.entries(d.env ?? {}).map(([k, v]) => ` --env ${k}=${v}`).join("");
      const when = d.schedule ? ` --schedule ${d.schedule} --restart no` : ` --restart ${d.restart ?? "always"}`;
      const secretsNote = d.secrets?.length ? `  # first: fly secrets set (app-wide) ${d.secrets.join(", ")}` : "";
      out.push({ machine: d.name, kind: "missing", detail: `not running (${d.schedule ? `scheduled ${d.schedule}` : "always-on"})`, gate: d.gate, requires: req,
        command: `fly machine run ${targetImage} ${(d.cmd ?? []).join(" ")} ${A} --region ${fleet.region} --name ${d.name} --vm-size shared-cpu-1x --vm-memory 512${when}${env}${secretsNote}` });
      continue;
    }
    if (digestOf(a.image) !== digestOf(targetImage)) {
      out.push({ machine: d.name, kind: "image_drift", detail: `runs ${digestOf(a.image).slice(0, 19)}…, release is ${digestOf(targetImage).slice(0, 19)}…`, gate: d.gate, requires: req,
        command: d.managedBy === "fly deploy" ? `fly deploy --config fly.hub.toml --image ${targetImage} --ha=false` : `fly machine update ${a.id} ${A} --image ${targetImage} --yes` });
    }
    const drift: string[] = [];
    if (d.schedule && a.schedule !== d.schedule) drift.push(`schedule ${a.schedule ?? "none"} != ${d.schedule}`);
    if (d.cmd && JSON.stringify(a.cmd) !== JSON.stringify(d.cmd)) drift.push(`cmd ${JSON.stringify(a.cmd)} != ${JSON.stringify(d.cmd)}`);
    for (const [k, v] of Object.entries(d.env ?? {})) if (a.env[k] !== v) drift.push(`env ${k}=${a.env[k] ?? "unset"} (want ${v})`);
    if (drift.length) out.push({ machine: d.name, kind: "config_drift", detail: drift.join("; "), gate: d.gate, requires: req, command: `# reconcile by hand: ${drift.join("; ")}` });
  }
  const declared = new Set(fleet.machines.map((m) => m.name));
  for (const a of actual) if (!declared.has(a.name)) out.push({ machine: a.name, kind: "unexpected", detail: `machine ${a.id} is not declared in deploy/fleet.json`, gate: "review", requires: [], command: null });
  return out;
}

export function parseMachines(json: unknown): Actual[] {
  return (json as Array<Record<string, any>>).map((m) => ({ id: m.id, name: m.name, state: m.state, image: m.config?.image ?? "",
    schedule: m.config?.schedule ?? null, cmd: m.config?.init?.cmd ?? null, env: m.config?.env ?? {} }));
}

if (process.argv[1]?.endsWith("fleet-plan.ts")) {
  const target = process.argv[2]; const mi = process.argv.indexOf("--machines");
  if (!target) { console.error("usage: fleet-plan.ts <target image ref> [--machines saved.json]"); process.exit(2); }
  const fleet = JSON.parse(readFileSync(join(process.cwd(), "deploy", "fleet.json"), "utf8")) as Fleet;
  const raw = mi > 0 ? readFileSync(process.argv[mi + 1]!, "utf8") : execFileSync("fly", ["machines", "list", "--app", fleet.app, "--json"], { encoding: "utf8" });
  const changes = planFleet(fleet, parseMachines(JSON.parse(raw)), target);
  if (!changes.length) { console.log("fleet matches deploy/fleet.json at the target image"); process.exit(0); }
  for (const c of changes) {
    console.log(`[${c.kind}] ${c.machine}: ${c.detail}\n    approval: ${c.gate}${c.requires.length ? `; requires: ${c.requires.join(", ")}` : ""}${c.command ? `\n    ${c.command}` : ""}`);
  }
  process.exit(1);
}
