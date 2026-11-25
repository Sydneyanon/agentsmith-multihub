// Real-Postgres integration tests. Requires TEST_DATABASE_URL pointing at a LOOPBACK Postgres
// server (the tests create and drop their own agentsmith_test_<hex> databases and refuse any
// non-loopback host). With no database configured this exits 2: it never silently passes.
import { spawnSync } from "node:child_process";

if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL is not set: refusing to report integration tests as passing.\n" +
    "Point it at a disposable local Postgres, e.g. postgres://user@127.0.0.1:5432/postgres");
  process.exit(2);
}
const result = spawnSync("npx", ["vitest", "run", "integration"], {
  stdio: "inherit",
  env: { ...process.env, REQUIRE_INTEGRATION: "1" },
});
process.exit(result.status ?? 1);
