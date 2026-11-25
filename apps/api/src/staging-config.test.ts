import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAGING_FILES, stagingBootstrap, stagingFull } from "../../../scripts/staging-config.js";

const read = (relative: string) => readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");
const source = read("fly.toml");
const full = read(STAGING_FILES.full);
const bootstrap = read(STAGING_FILES.bootstrap);

const processGroups = (toml: string) =>
  [...toml.split("[processes]")[1]!.split(/\n\[/)[0]!.matchAll(/^\s*(\w+)\s*=\s*"/gm)].map((match) => match[1]);
const vmGroups = (toml: string) => [...toml.matchAll(/\[\[vm\]\]\s+processes = \["(\w+)"\]/g)].map((match) => match[1]);

describe("staging Fly configs", () => {
  it("are exactly what the generator derives from fly.toml, so they cannot drift", () => {
    expect(full).toBe(stagingFull(source));
    expect(bootstrap).toBe(stagingBootstrap(source));
  });

  it("name only the staging app and never the existing one", () => {
    for (const toml of [full, bootstrap]) {
      expect(toml).toMatch(/^app = "agentsmith-multihub-staging"$/m);
      expect(toml).not.toMatch(/^app = "agentsmith-multihub"$/m);
    }
  });

  it("deploy the app and worker groups in the full config", () => {
    expect(processGroups(full)).toEqual(["app", "worker"]);
    expect(vmGroups(full)).toEqual(["app", "worker"]);
  });

  it("define no worker group, command or VM in the first-release config, so no worker Machine can start without a database", () => {
    expect(processGroups(bootstrap)).toEqual(["app"]);
    expect(vmGroups(bootstrap)).toEqual(["app"]);
    expect(bootstrap.split("\n").filter((line) => !line.startsWith("#")).join("\n")).not.toContain("worker");
  });

  it("otherwise match fly.toml: same service, health check, environment and no release command or secrets", () => {
    const strip = (toml: string) => toml.split("\n").filter((line) => !line.startsWith("#") && !/^app = /.test(line)).join("\n");
    expect(strip(full)).toBe(strip(source));
    for (const toml of [full, bootstrap]) {
      expect(toml).toMatch(/\[http_service\][\s\S]*?processes = \["app"\]/);
      expect(toml).toContain('path = "/health/live"');
      for (const forbidden of ["release_command", "DATABASE_URL", "DIRECT_DATABASE_URL", "DATABASE_SSL_VERIFY", "postgres://"]) {
        expect(toml, forbidden).not.toContain(forbidden);
      }
    }
  });

  it("fail loudly if fly.toml changes shape instead of generating a wrong config", () => {
    expect(() => stagingBootstrap(source.replace('  worker = "npm run worker:intake"\n', ""))).toThrow(/worker process line/);
    expect(() => stagingFull(source.replace('app = "agentsmith-multihub"', 'app = "other"'))).toThrow(/app header block/);
  });
});

describe("staging runbook", () => {
  const runbook = read("docs/fly-staging-runbook.md");

  it("makes the first release app-only from the bootstrap config, not by scaling the worker down afterwards", () => {
    expect(runbook).toContain("--config fly.staging-bootstrap.toml");
    expect(runbook).toContain("--app agentsmith-multihub-staging");
    expect(runbook).toContain("--ha=false");
    const order = runbook.slice(runbook.indexOf("## Order of operations"), runbook.indexOf("## Stop conditions"));
    expect(order).not.toMatch(/worker=0/);
    expect(runbook).toMatch(/creates and starts at least one Machine for each process group/);
  });

  it("adds the worker only in a later release, after the database is attached and migrated", () => {
    const secondRelease = runbook.indexOf("--config fly.staging.toml");
    expect(secondRelease).toBeGreaterThan(runbook.indexOf("fly.staging-bootstrap.toml"));
    expect(secondRelease).toBeGreaterThan(runbook.indexOf("node dist/scripts/migrate.js"));
  });

  it("never points a staging command at fly.toml", () => {
    expect(runbook).not.toMatch(/--config fly\.toml/);
  });
});
