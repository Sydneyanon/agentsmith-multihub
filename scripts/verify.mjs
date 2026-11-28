// Session-run verification (no GitHub Actions dependency).
// Runs every check, prints an honest summary, and exits non-zero if any check failed.
// A check that was not run is reported SKIPPED and never counts as a pass.
// `npm test` is unit tests with a mocked database; real Postgres is `test:integration` (TEST_DATABASE_URL).
//   npm run verify            lockfile consistency, typecheck, tests, build
//   npm run verify -- --docker  also attempt a real `docker build` (skipped if no daemon)
import { spawnSync } from "node:child_process";

const wantDocker = process.argv.includes("--docker");
const run = (command, args) => spawnSync(command, args, { stdio: "inherit", shell: false });
const quiet = (command, args) => spawnSync(command, args, { encoding: "utf8" });

const steps = [
  { name: "lockfile consistent (npm ci --dry-run)", command: "npm", args: ["ci", "--dry-run", "--no-audit", "--no-fund"] },
  { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { name: "tests", command: "npm", args: ["run", "test"] },
  { name: "build", command: "npm", args: ["run", "build"] },
  {
    name: "integration tests (real Postgres)", command: "npm", args: ["run", "test:integration"],
    skipUnless: Boolean(process.env.TEST_DATABASE_URL), skipReason: "TEST_DATABASE_URL not set",
  },
  {
    // The same suite again with the code under test connected as the least-privilege runtime role (needs CREATEROLE on the test login).
    name: "integration tests as the restricted runtime role", command: "npm", args: ["run", "test:integration:restricted"],
    skipUnless: Boolean(process.env.TEST_DATABASE_URL), skipReason: "TEST_DATABASE_URL not set",
  },
];
if (wantDocker) steps.push({ name: "docker image build", command: "docker", args: ["build", "-t", "agentsmith-multihub:verify", "."], needsDocker: true });

const git = (args) => quiet("git", args).stdout?.trim() ?? "";
console.log(`verify: node ${process.version}, commit ${git(["rev-parse", "--short", "HEAD"])}, ` +
  `${git(["status", "--porcelain"]) ? "working tree DIRTY" : "working tree clean"}, ${new Date().toISOString()}`);

const results = [];
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  if (step.skipUnless === false) {
    console.log(`SKIPPED: ${step.skipReason}`);
    results.push({ name: step.name, outcome: "SKIPPED", detail: step.skipReason });
    continue;
  }
  if (step.needsDocker && quiet("docker", ["info"]).status !== 0) {
    console.log("SKIPPED: no reachable Docker daemon");
    results.push({ name: step.name, outcome: "SKIPPED", detail: "no reachable Docker daemon" });
    continue;
  }
  const started = Date.now();
  const result = run(step.command, step.args);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ name: step.name, outcome: result.status === 0 ? "PASS" : "FAIL", detail: `exit ${result.status ?? result.signal} in ${seconds}s` });
}

console.log("\n=== summary ===");
for (const r of results) console.log(`${r.outcome.padEnd(7)} ${r.name} (${r.detail})`);
if (!wantDocker) console.log("NOTE    docker image build not attempted (use `npm run verify -- --docker`)");
console.log("NOTE    this is a local run: it is not independent CI and is not evidence of a deployment.");
process.exit(results.some((r) => r.outcome === "FAIL") ? 1 : 0);
