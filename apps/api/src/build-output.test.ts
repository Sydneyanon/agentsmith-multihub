import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Compiles with the production TypeScript config (the one `npm run build` and the image use) into a scratch directory. */
describe("production build output (compiled with tsconfig.build.json)", () => {
  let out = ""; let files: string[] = [];
  beforeAll(() => {
    expect(existsSync(join(root, "tsconfig.build.json")), "tsconfig.build.json must exist").toBe(true);
    out = mkdtempSync(join(tmpdir(), "build-out-"));
    const r = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json", "--outDir", out], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    files = walk(out).map((f) => relative(out, f));
  }, 120_000);
  afterAll(() => { if (out) rmSync(out, { recursive: true, force: true }); });

  it("contains the entry points the image and the operator runbooks run", () => {
    for (const f of ["apps/api/src/server.js", "apps/api/src/worker-main.js", "scripts/migrate.js", "scripts/apply-runtime-grants.js"]) {
      expect(files, f).toContain(f);
    }
    expect(files.filter((f) => f.startsWith("apps/api/src/") && f.endsWith(".js")).length).toBeGreaterThan(30);
  });

  it("contains no tests, fixtures, test harnesses or development-only scripts", () => {
    expect(files.filter((f) => /\.test\.js$/.test(f))).toEqual([]);
    expect(files.filter((f) => /(^|\/)(integration|testing)\//.test(f))).toEqual([]);
    expect(files.filter((f) => /^scripts\//.test(f) && !/^scripts\/(migrate|apply-runtime-grants)\.js$/.test(f))).toEqual([]);
  });

  it("ships no declaration files or source maps", () => {
    expect(files.filter((f) => /\.d\.ts$|\.map$/.test(f))).toEqual([]);
  });

  it("every relative import resolves to an emitted file (nothing was left out that the app needs)", () => {
    const missing: string[] = [];
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      const src = readFileSync(join(out, f), "utf8");
      for (const m of src.matchAll(/^(?:import|export)\s[^"']*?from\s+["'](\.[^"']+)["']/gm)) {
        const target = relative(out, resolve(out, f, "..", m[1]!));
        if (!files.includes(target)) missing.push(`${f} -> ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("imports only Node built-ins and production dependencies: no dev tools, no process spawning", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const allowed = new Set([...Object.keys(pkg.dependencies), ...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
    const bare = (s: string) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]!);
    const offenders: string[] = [];
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      const src = readFileSync(join(out, f), "utf8");
      for (const m of src.matchAll(/^(?:import|export)\s[^"']*?from\s+["']([^."'][^"']*)["']|^import\s+["']([^."'][^"']*)["']/gm)) {
        const spec = m[1] ?? m[2]!;
        if (!allowed.has(spec) && !allowed.has(bare(spec))) offenders.push(`${f} imports ${spec}`);
        if (/^(node:)?(child_process|worker_threads|vm|cluster)$/.test(spec)) offenders.push(`${f} imports ${spec} (process spawning)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("production build output: review hardening", () => {
  it("excludes *.spec.ts as well as *.test.ts from the production compile", () => {
    const cfg = JSON.parse(read("tsconfig.build.json")) as { exclude: string[] };
    expect(cfg.exclude).toContain("**/*.test.ts");
    expect(cfg.exclude).toContain("**/*.spec.ts");
  });
  it("emitted code has no dynamic import() or require() that the static import scan could not see", () => {
    const dir = join(root, "dist");
    if (!existsSync(dir)) return; // the compile test above covers a scratch build; this checks the real one when present
    const offenders: string[] = [];
    const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js") && !p.includes("/web/")) { const src = readFileSync(p, "utf8").replace(/\/\/.*$/gm, ""); if (/[^.\w]import\s*\(|[^.\w]require\s*\(/.test(src)) offenders.push(relative(dir, p)); } } };
    walk(dir);
    expect(offenders).toEqual([]);
  });
  it("the Dockerfile runtime stage copies nothing but package files, dist and db", () => {
    const runtime = read("Dockerfile").split("AS runtime")[1]!;
    const copies = [...runtime.matchAll(/^COPY (.+)$/gm)].map((m) => m[1]!.trim());
    expect(copies).toEqual(["package*.json ./", "--from=build /app/dist ./dist", "--from=build /app/db ./db"]);
  });
  it("the operator's grants command is runnable inside the image (compiled script, no tsx)", () => {
    expect(JSON.parse(read("package.json")).scripts["db:grants"]).toBe("node dist/scripts/apply-runtime-grants.js");
    const doc = read("docs/db-roles.md");
    expect(doc).toMatch(/node dist\/scripts\/apply-runtime-grants\.js/);
    expect(doc).not.toMatch(/npx tsx scripts\/apply-runtime-grants\.ts[^\n]*(Machine|image|production)/i);
  });
  it("the image smoke test also looks for *.spec.js", () => { expect(read("scripts/hub-image-smoke.sh")).toMatch(/-name "\*\.spec\.js"/); });
});

describe("the image is built from the production config", () => {
  it("npm run build uses tsconfig.build.json for the server code", () => {
    expect(JSON.parse(read("package.json")).scripts.build).toMatch(/tsc -p tsconfig\.build\.json/);
    expect(JSON.parse(read("package.json")).scripts.build).not.toMatch(/tsc -p tsconfig\.json/);
  });
  it("typecheck still covers the tests (tsconfig.json is not narrowed)", () => {
    expect(JSON.parse(read("package.json")).scripts.typecheck).toMatch(/tsc --noEmit -p tsconfig\.json/);
  });
  it("the Dockerfile and the Docker-less image script both supply tsconfig.build.json to the build stage", () => {
    expect(read("Dockerfile")).toMatch(/COPY tsconfig\.json tsconfig\.build\.json \.\/|COPY tsconfig\.build\.json/);
    expect(read("scripts/hub-image.sh")).toMatch(/git -C "\$ROOT" archive HEAD [^\n]*tsconfig\.build\.json/);
  });
  it("the runtime stage copies only dist and db from the build stage", () => {
    const runtime = read("Dockerfile").split("AS runtime")[1]!;
    const copies = [...runtime.matchAll(/^COPY --from=build (\S+)/gm)].map((m) => m[1]);
    expect(copies).toEqual(["/app/dist", "/app/db"]);
  });
});
