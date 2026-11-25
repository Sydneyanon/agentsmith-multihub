import { describe, expect, it } from "vitest";
import { isValidBearerToken } from "./auth.js";

describe("API bearer authentication", () => {
  const token = "a".repeat(48);

  it("accepts the exact configured bearer token", () => {
    expect(isValidBearerToken(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects missing, malformed and incorrect tokens", () => {
    expect(isValidBearerToken(undefined, token)).toBe(false);
    expect(isValidBearerToken("Basic abc", token)).toBe(false);
    expect(isValidBearerToken(`Bearer ${"b".repeat(48)}`, token)).toBe(false);
    expect(isValidBearerToken(`Bearer ${token}`, undefined)).toBe(false);
  });
});
