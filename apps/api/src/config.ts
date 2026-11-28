import { z } from "zod";
import { assessTokenStrength } from "./auth.js";
import { parseCidrList } from "./client-identity.js";
import { parseAllowedHosts } from "./host-guard.js";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url().optional().or(z.literal("")),
  API_BEARER_TOKEN: z.string().superRefine((token, ctx) => {
    if (token === "") return;
    const problem = assessTokenStrength(token);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `API_BEARER_TOKEN ${problem}` });
  }).optional(),
  HUB_ALLOWED_HOSTS: z.string().superRefine((raw, ctx) => {
    const parsed = parseAllowedHosts(raw);
    if ("error" in parsed) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `HUB_ALLOWED_HOSTS ${parsed.error}` });
  }).optional(),
  HUB_TRUSTED_PROXY_CIDRS: z.string().superRefine((raw, ctx) => {
    const parsed = parseCidrList(raw);
    if ("error" in parsed) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `HUB_TRUSTED_PROXY_CIDRS ${parsed.error}` });
  }).optional(),
  HUB_REQUIRE_RESTRICTED_DB_ROLE: z.enum(["true", "false"]).default("false"),
  AI_BUDGET_EMERGENCY_STOP: z.enum(["true", "false"]).default("false"),
  /** What the connected database holds, as declared by the operator; shown on the Control Room. Never inferred. */
  HUB_DATA_KIND: z.enum(["production", "synthetic", "test", "unlabelled"]).default("unlabelled"),
  /** Option D: serve the internal worker API, only on a second listener (WORKER_API_HOST:WORKER_API_PORT, the private 6PN address). Off by default. */
  WORKER_API_ENABLED: z.enum(["true", "false"]).default("false"),
  WORKER_API_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  WORKER_API_HOST: z.string().min(1).default("fly-local-6pn"),
  /** D4 per-token quotas and D1/D3 analysis limits (all optional; defaults in worker-quotas.ts and bounded-compute.ts) */
  WORKER_API_QUOTA_BYTES: z.coerce.number().int().min(1).optional(),
  WORKER_API_QUOTA_BLOBS: z.coerce.number().int().min(1).optional(),
  WORKER_API_QUOTA_READ_BYTES: z.coerce.number().int().min(1).optional(),
  WORKER_API_QUOTA_PROCESSING_MS: z.coerce.number().int().min(1).optional(),
  WORKER_API_RATE_PER_SECOND: z.coerce.number().int().min(1).optional(),
  WORKER_API_RATE_BURST: z.coerce.number().int().min(1).optional(),
  WORKER_API_COMPUTE_CPU_MS: z.coerce.number().int().min(1).optional(),
  WORKER_API_COMPUTE_WALL_MS: z.coerce.number().int().min(1).optional(),
  WORKER_API_COMPUTE_HEAP_MB: z.coerce.number().int().min(16).optional(),
  WORKER_API_MAX_SNAPSHOT_BYTES: z.coerce.number().int().min(1).optional(),
  /** TESTS ONLY (NODE_ENV=test): a loopback GitHub fake for the API's own verification source; GitHubSource refuses it elsewhere */
  WORKER_API_GITHUB_TEST_ORIGIN: z.string().url().optional(),
});

const parsed = configSchema.safeParse(process.env);
if (!parsed.success) throw new Error(`Invalid environment configuration: ${parsed.error.message}`);

export const config = {
  environment: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  host: parsed.data.HOST,
  logLevel: parsed.data.LOG_LEVEL,
  databaseUrl: parsed.data.DATABASE_URL || undefined,
  apiBearerToken: parsed.data.API_BEARER_TOKEN || undefined,
  hubAllowedHosts: ((): string[] => { const result = parseAllowedHosts(parsed.data.HUB_ALLOWED_HOSTS); return "hosts" in result ? result.hosts : []; })(),
  trustedProxyCidrs: (parsed.data.HUB_TRUSTED_PROXY_CIDRS ?? "").split(",").map((c) => c.trim()).filter(Boolean),
  requireRestrictedDbRole: parsed.data.HUB_REQUIRE_RESTRICTED_DB_ROLE === "true",
  aiBudgetEmergencyStop: parsed.data.AI_BUDGET_EMERGENCY_STOP === "true",
  dataKind: parsed.data.HUB_DATA_KIND,
  workerApi: {
    enabled: parsed.data.WORKER_API_ENABLED === "true", port: parsed.data.WORKER_API_PORT, host: parsed.data.WORKER_API_HOST,
    quotas: { ...(parsed.data.WORKER_API_QUOTA_BYTES ? { maxBytesStored: parsed.data.WORKER_API_QUOTA_BYTES } : {}), ...(parsed.data.WORKER_API_QUOTA_BLOBS ? { maxBlobs: parsed.data.WORKER_API_QUOTA_BLOBS } : {}),
      ...(parsed.data.WORKER_API_QUOTA_READ_BYTES ? { maxBytesRead: parsed.data.WORKER_API_QUOTA_READ_BYTES } : {}), ...(parsed.data.WORKER_API_QUOTA_PROCESSING_MS ? { maxProcessingMs: parsed.data.WORKER_API_QUOTA_PROCESSING_MS } : {}) },
    rateLimit: parsed.data.WORKER_API_RATE_PER_SECOND || parsed.data.WORKER_API_RATE_BURST ? { perSecond: parsed.data.WORKER_API_RATE_PER_SECOND ?? 200, burst: parsed.data.WORKER_API_RATE_BURST ?? 400 } : undefined,
    compute: { ...(parsed.data.WORKER_API_COMPUTE_CPU_MS ? { cpuMs: parsed.data.WORKER_API_COMPUTE_CPU_MS } : {}), ...(parsed.data.WORKER_API_COMPUTE_WALL_MS ? { wallMs: parsed.data.WORKER_API_COMPUTE_WALL_MS } : {}),
      ...(parsed.data.WORKER_API_COMPUTE_HEAP_MB ? { maxHeapMb: parsed.data.WORKER_API_COMPUTE_HEAP_MB } : {}), ...(parsed.data.WORKER_API_MAX_SNAPSHOT_BYTES ? { maxInputBytes: parsed.data.WORKER_API_MAX_SNAPSHOT_BYTES } : {}) },
    githubTestOrigin: parsed.data.WORKER_API_GITHUB_TEST_ORIGIN,
  },
} as const;
