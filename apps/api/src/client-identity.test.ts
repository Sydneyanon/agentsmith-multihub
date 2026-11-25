import { describe, expect, it } from "vitest";
import { inCidr, parseCidr, parseCidrList } from "./client-identity.js";

describe("CIDR parsing is strict", () => {
  it("accepts exact IPv4 and IPv6 ranges", () => {
    expect(typeof parseCidr("172.19.0.0/16")).toBe("object");
    expect(typeof parseCidr("fdaa::/16")).toBe("object");
  });
  it("rejects bare addresses, wildcards, junk, bad prefixes and ranges so wide they trust the internet", () => {
    for (const bad of ["172.19.0.1", "172.19.*.*", "x/16", "1.2.3.4/33", "::/129", "0.0.0.0/0", "10.0.0.0/7", "::/0", "fc00::/15", "1.2.3/24", "01.2.3.4/24"]) {
      expect(typeof parseCidr(bad), bad).toBe("string");
    }
    expect("error" in parseCidrList("172.19.0.0/16, nope")).toBe(true);
    expect(parseCidrList("")).toEqual({ cidrs: [] });
  });
});

describe("CIDR membership", () => {
  const net = parseCidr("172.19.0.0/16") as Exclude<ReturnType<typeof parseCidr>, string>;
  it("matches on the prefix boundary only", () => {
    expect(inCidr("172.19.0.0", net)).toBe(true);
    expect(inCidr("172.19.255.255", net)).toBe(true);
    expect(inCidr("172.20.0.0", net)).toBe(false);
    expect(inCidr("172.18.255.255", net)).toBe(false);
    expect(inCidr("::ffff:172.19.5.233", net)).toBe(true);
    expect(inCidr("fdaa::1", net)).toBe(false);
    expect(inCidr("garbage", net)).toBe(false);
  });
});
