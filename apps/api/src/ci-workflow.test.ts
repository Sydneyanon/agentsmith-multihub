import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const wf = readFileSync(join(__dirname, "..", "..", "..", ".github", "workflows", "ci.yml"), "utf8");
const code = wf.replace(/^\s*#.*$/gm, "");
const section = (name: string) => {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]+:\\n|(?![\\s\\S]))`, "m").exec(code);
  expect(m, `job ${name}`).toBeTruthy();
  return m![1]!;
};

describe("CI workflow covers stacked pull requests", () => {
  const on = /^on:\n([\s\S]*?)(?=^\S)/m.exec(code)![1]!;
  it("runs for pull requests into ANY base branch (no branch filter on pull_request)", () => {
    expect(on).toMatch(/^  pull_request:\s*$/m);
    const pr = /^  pull_request:\n((?:    .*\n)*)/m.exec(on)?.[1] ?? "";
    expect(pr).not.toMatch(/branches/);
  });
  it("also runs on pushes to main and can be started by hand", () => {
    expect(on).toMatch(/^  push:\n    branches: \[main\]/m);
    expect(on).toMatch(/^  workflow_dispatch:/m);
  });
  it("has the three jobs: validate, integration, image", () => {
    for (const j of ["validate", "integration", "image"]) expect(code).toMatch(new RegExp(`^  ${j}:`, "m"));
  });
});

describe("CI is safe: no secrets, no deployment, no production", () => {
  it("has read-only repository permissions and never uses pull_request_target", () => {
    expect(code).toMatch(/^permissions:\n  contents: read\s*$/m);
    expect(code).not.toMatch(/pull_request_target/);
    expect(code).not.toMatch(/write/);
  });
  it("references no secrets and nothing from Fly or the production hostnames", () => {
    expect(code).not.toMatch(/secrets\./);
    expect(code).not.toMatch(/FLY_|fly\.io|flyctl|registry\.fly|agentsmithdesk|DATABASE_URL: postgres:\/\/[^@]*@(?!127\.0\.0\.1)/i);
    expect(code).not.toMatch(/docker (push|login)|crane|fly deploy/);
  });
  it("actions are pinned to a released major version, never a moving branch", () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const u of uses) expect(u, u).toMatch(/@v\d+$/);
  });
  it("every job has a timeout", () => { expect((code.match(/timeout-minutes:/g) ?? []).length).toBe(3); });
});

describe("integration job uses a disposable loopback Postgres and cannot pass by skipping", () => {
  const job = section("integration");
  it("starts a Postgres service container bound to the runner's loopback", () => {
    expect(job).toMatch(/image: postgres:16/);
    expect(job).toMatch(/127\.0\.0\.1:5432:5432/);
    expect(job).toMatch(/--health-cmd "pg_isready/);
  });
  it("points the tests only at that service, on 127.0.0.1", () => {
    expect(job).toMatch(/TEST_DATABASE_URL: postgres:\/\/postgres:[^@\s]+@127\.0\.0\.1:5432\/postgres/);
    expect([...job.matchAll(/postgres:\/\/[^\s"]+/g)].every((m) => /@127\.0\.0\.1:/.test(m[0]))).toBe(true);
  });
  it("requires integration (a missing database fails the job) and runs both the plain and the restricted-role suites", () => {
    expect(job).toMatch(/REQUIRE_INTEGRATION: "1"/);
    expect(job).toMatch(/run: npm run test:integration\s*$/m);
    expect(job).toMatch(/run: npm run test:integration:restricted/);
  });
});

describe("validate and image jobs", () => {
  it("validate runs lockfile install, typecheck, unit tests and build", () => {
    const job = section("validate");
    for (const c of ["npm ci", "npm run typecheck", "npm run test", "npm run build"]) expect(job, c).toContain(`run: ${c}`);
  });
  it("image job does a genuine docker build of the repository Dockerfile and checks the contents and behaviour", () => {
    const job = section("image");
    expect(job).toMatch(/docker build --tag agentsmith-hub:ci \./);
    expect(job).toMatch(/\*\.test\.js/);
    expect(job).toMatch(/-path "\*\/integration\/\*" -o -path "\*\/testing\/\*"/);
    expect(job).toMatch(/runtime-grants\.json/);
    expect(job).toMatch(/= 401/);
    expect(job).toMatch(/-d '\{not json'[^\n]*= 401|\{not json[^\n]*\n?[^\n]*401/);
    expect(job).toMatch(/= 421/);
    expect(job).toMatch(/= 429/);
    expect(job).toMatch(/grep -q "\$TOKEN"/);
  });
  it("the image job publishes nothing and the runtime stage still copies only dist and db", () => {
    expect(section("image")).not.toMatch(/docker push|docker login|upload-artifact|ghcr\.io|registry\.fly/);
    expect(readFileSync(join(__dirname, "..", "..", "..", "Dockerfile"), "utf8").split("AS runtime")[1]).toMatch(/COPY --from=build \/app\/dist \.\/dist\nCOPY --from=build \/app\/db \.\/db/);
  });
});
