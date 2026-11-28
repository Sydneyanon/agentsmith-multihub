import { Pool } from "pg";
import { buildPoolConfig, stderrWarning } from "./db-config.js";
import { mintWorkerToken, revokeWorkerToken, WorkerTokenError } from "./worker-tokens.js";

/**
 * Option D operator CLI (owner connection, DATABASE_URL). The token never passes through a terminal or a chat session:
 *
 *   node dist/apps/api/src/worker-token-main.js mint --run <uuid> [--ttl-hours 24] --by <operator> \
 *     | fly secrets import --stage -a <worker-app>
 *
 * `mint` writes exactly one line, `WORKER_API_TOKEN=<token>`, to stdout and REFUSES when stdout is a terminal (so the token is not
 * displayed, scrolled back or copied into a chat). Everything human-readable (token id, run, expiry) goes to stderr.
 *
 *   node dist/apps/api/src/worker-token-main.js revoke --token-id <uuid> --by <operator> [--reason "..."]
 *
 * Exit codes: 0 done; 2 usage; 3 refused (run missing, finished or not a repository_research run; stdout is a terminal).
 */
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const err = (m: string) => process.stderr.write(`${m}\n`);
const command = args[0];
if (command !== "mint" && command !== "revoke") { err("usage: worker-token-main.js mint --run <uuid> --by <operator> [--ttl-hours N] | revoke --token-id <uuid> --by <operator> [--reason text]"); process.exit(2); }
const by = flag("by");
if (!by) { err("--by <operator> is required (it is recorded in audit_events)"); process.exit(2); }
if (command === "mint" && process.stdout.isTTY) { err("refusing to print a worker token to a terminal: pipe it, e.g. `... | fly secrets import --stage -a <worker-app>`"); process.exit(3); }

const pool = new Pool(buildPoolConfig(process.env, { max: 1, onWarning: stderrWarning, applicationName: "agentsmith-worker-token-cli" }));
try {
  if (command === "mint") {
    const run = flag("run"); const hours = flag("ttl-hours");
    if (!run) { err("--run <uuid> is required"); process.exitCode = 2; }
    else {
      const minted = await mintWorkerToken(pool, { runId: run, createdBy: by, ...(hours ? { ttlSeconds: Math.round(Number(hours) * 3600) } : {}) });
      process.stdout.write(`WORKER_API_TOKEN=${minted.token}\n`);
      err(`minted worker token ${minted.tokenId} for run ${minted.runId}, expires ${minted.expiresAt} (the token itself was written to stdout only)`);
    }
  } else {
    const id = flag("token-id");
    if (!id) { err("--token-id <uuid> is required"); process.exitCode = 2; }
    else {
      const reason = flag("reason");
      const r = await revokeWorkerToken(pool, { tokenId: id, revokedBy: by, ...(reason ? { reason } : {}) });
      err(r.revoked ? `revoked worker token ${id}` : `worker token ${id} was not found or was already revoked`);
      if (!r.revoked) process.exitCode = 3;
    }
  }
} catch (error) {
  err(error instanceof WorkerTokenError ? `refused (${error.code}): ${error.message}` : `failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof WorkerTokenError ? 3 : 1;
} finally {
  await pool.end();
}
