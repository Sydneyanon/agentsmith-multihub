import { timingSafeEqual } from "node:crypto";

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
