import { describe, expect, it } from "vitest";
import { parseMachines, planFleet, type Fleet } from "./fleet-plan.js";

const D = (n: string) => `registry.fly.io/agentsmith-hub@sha256:${n.repeat(64).slice(0, 64)}`;
const fleet: Fleet = { app: "agentsmith-hub", region: "syd", machines: [
  { name: "api", role: "api", processGroup: "app", managedBy: "fly deploy", gate: "deploy" },
  { name: "collector", role: "job", schedule: "hourly", cmd: ["collect.js"], gate: "deploy" },
  { name: "worker", role: "worker", restart: "always", cmd: ["worker.js"], env: { STRUCTURAL_ANALYSIS_ENABLED: "true" }, secrets: ["WORKER_DATABASE_URL"], gate: "worker activation", requires: ["R1"] },
] };
const machine = (id: string, name: string, image: string, extra: Record<string, unknown> = {}) => ({ id, name, state: "started", config: { image, ...extra } });

describe("fleet plan (read-only drift report)", () => {
  it("reports nothing when every declared machine runs the release image with the declared config", () => {
    const actual = parseMachines([machine("1", "api", D("a")), machine("2", "collector", D("a"), { schedule: "hourly", init: { cmd: ["collect.js"] } }),
      machine("3", "worker", D("a"), { init: { cmd: ["worker.js"] }, env: { STRUCTURAL_ANALYSIS_ENABLED: "true" } })]);
    expect(planFleet(fleet, actual, D("a"))).toEqual([]);
  });

  it("catches a scheduled machine left on an old image (fly deploy does not update it) and the missing worker", () => {
    const actual = parseMachines([machine("1", "api", D("a")), machine("2", "collector", D("b"), { schedule: "hourly", init: { cmd: ["collect.js"] } })]);
    const plan = planFleet(fleet, actual, D("a"));
    expect(plan.map((c) => `${c.kind}:${c.machine}`)).toEqual(["image_drift:collector", "missing:worker"]);
    expect(plan[0]!.command).toBe(`fly machine update 2 --app agentsmith-hub --image ${D("a")} --yes`);
    expect(plan[1]).toMatchObject({ gate: "worker activation", requires: ["R1"] });
    expect(plan[1]!.command).toMatch(/--restart always --env STRUCTURAL_ANALYSIS_ENABLED=true/);
    expect(plan[1]!.command).toMatch(/ -- worker\.js/); // the job command follows "--", so its own flags are not parsed by fly
  });

  it("flags config drift and undeclared machines without inventing a fix", () => {
    const actual = parseMachines([machine("1", "api", D("a")), machine("2", "collector", D("a"), { schedule: "daily", init: { cmd: ["collect.js"] } }), machine("9", "stray", D("a"))]);
    const plan = planFleet({ ...fleet, machines: fleet.machines.slice(0, 2) }, actual, D("a"));
    expect(plan.map((c) => `${c.kind}:${c.machine}`)).toEqual(["config_drift:collector", "unexpected:stray"]);
    expect(plan[1]!.command).toBeNull();
  });
});
