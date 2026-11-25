import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
const fly = read("fly.toml");
const dockerfile = read("Dockerfile");

/** Lines of one top-level TOML table, e.g. [processes]. Enough for this flat file; no TOML dependency. */
function table(name: string): string[] {
  const lines = fly.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\[/.test(line)) break; // next top-level table (sub-tables are indented)
    body.push(line.trim());
  }
  return body.filter((line) => line && !line.startsWith("#"));
}

describe("runtime and Fly configuration", () => {
  const processes = Object.fromEntries(
    table("processes").map((line) => {
      const match = /^(\w+)\s*=\s*"([^"]+)"$/.exec(line);
      return match ? [match[1]!, match[2]!] : ["", line];
    }),
  );

  it("defines an app and a worker process group", () => {
    expect(Object.keys(processes).sort()).toEqual(["app", "worker"]);
  });

  it("runs every process group through an existing npm script", () => {
    for (const command of Object.values(processes)) {
      const match = /^npm (?:run )?(\w[\w:-]*)$/.exec(command);
      expect(match, `process command "${command}"`).not.toBeNull();
      const script = match![1]!;
      expect(pkg.scripts[script], `npm script "${script}"`).toBeDefined();
    }
  });

  it("starts production processes from compiled JavaScript, not tsx", () => {
    for (const script of ["start", "worker:intake", "db:migrate"]) {
      expect(pkg.scripts[script], script).toMatch(/^node dist\//);
      expect(pkg.scripts[script], script).not.toContain("tsx");
    }
    expect(pkg.scripts["worker:intake:dev"]).toContain("tsx");
  });

  it("keeps tsx a dev dependency that the runtime image does not install", () => {
    expect(pkg.devDependencies["tsx"]).toBeDefined();
    const runtimeStage = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    expect(runtimeStage).toContain("npm ci --omit=dev");
    expect(runtimeStage).not.toContain("tsx");
  });

  it("exposes only the app group over HTTP and checks liveness, not readiness", () => {
    expect(fly).toMatch(/\[http_service\][\s\S]*?processes = \["app"\]/);
    expect(fly).toContain('path = "/health/live"');
    expect(fly).not.toContain('path = "/health/ready"');
  });

  it("sizes both process groups and does not run migrations automatically", () => {
    expect(fly).toMatch(/\[\[vm\]\]\s+processes = \["app"\]/);
    expect(fly).toMatch(/\[\[vm\]\]\s+processes = \["worker"\]/);
    expect(fly).not.toContain("release_command");
  });

  it("keeps database URLs and the TLS override out of fly.toml (secrets and last-resort settings are never committed)", () => {
    for (const forbidden of ["DATABASE_URL", "DIRECT_DATABASE_URL", "DATABASE_SSL_VERIFY", "MIGRATE_CONFIRM_REMOTE_HOST", "postgres://"]) {
      expect(fly, forbidden).not.toContain(forbidden);
    }
  });

  it("makes the app-name hazard explicit", () => {
    expect(fly).toContain("Never deploy with this file without an explicit");
  });
});
