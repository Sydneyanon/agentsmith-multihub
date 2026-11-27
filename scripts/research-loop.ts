import { createInterface } from "node:readline/promises";
import { runCli } from "../apps/api/src/engine/cli.js";
import "../apps/api/src/engine/tools/tool-host/register.js"; // the operator CLI may run pinned tools (subject to the dry-run guard)

/** T-199 operator CLI. Usage: npm run loop -- <command> [flags]   (see `npm run loop -- help`). Dry run unless --execute --confirm. */
const prompt = process.stdin.isTTY
  ? async (q: string) => { const rl = createInterface({ input: process.stdin, output: process.stderr }); try { return await rl.question(q); } finally { rl.close(); } }
  : undefined;
const code = await runCli(process.argv.slice(2), { out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n"), env: process.env, ...(prompt ? { prompt } : {}) });
process.exit(code);
