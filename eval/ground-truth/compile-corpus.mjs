// Usage: node compile-corpus.mjs <contracts dir>   -> compiles every .sol file separately and reports pass/fail (no analyzer involved)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "./lib.mjs";
const dir = process.argv[2]; const rows = []; let solcVersion = "";
for (const f of readdirSync(dir).filter((n) => n.endsWith(".sol")).sort()) { const r = compile(`contracts/${f}`, readFileSync(join(dir, f), "utf8")); solcVersion = r.solcVersion; rows.push({ file: f, ok: r.errors.length === 0, errors: r.errors }); }
console.log(JSON.stringify({ solc: solcVersion, files: rows.length, compiled: rows.filter((r) => r.ok).length, failures: rows.filter((r) => !r.ok) }, null, 2));
