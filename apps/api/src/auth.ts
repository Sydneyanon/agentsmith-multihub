import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/** Constant-time comparison for the configured single-operator API bearer token. */
export function isValidBearerToken(header: string | undefined, configuredToken: string | undefined): boolean {
  if (!header || !configuredToken) return false;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  if (!match?.[1]) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(configuredToken, "utf8");
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

/**
 * Single-operator bearer protection for every /v1/ route. Without a configured token the API refuses (503) instead of
 * running open; a missing or wrong token is 401. Shared by the server and the tests so they cannot drift apart.
 */
export function registerBearerAuth(app: FastifyInstance, configuredToken: string | undefined): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    if (!configuredToken) return reply.code(503).send({ error: "api_auth_not_configured" });
    if (!isValidBearerToken(request.headers.authorization, configuredToken)) return reply.code(401).send({ error: "unauthorized" });
  });
}
