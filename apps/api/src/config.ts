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
} as const;
