import { describe, expect, it } from "vitest";
import { classifyAddress, isPublicAddress, normalizeHostname, assessHostname } from "./ip-policy.js";

const blocked = (ip: string) => expect(isPublicAddress(ip), `${ip} must be blocked`).toBe(false);
const allowed = (ip: string) => expect(isPublicAddress(ip), `${ip} must be allowed`).toBe(true);

describe("IPv4 special-use ranges (boundaries)", () => {
  const table: Array<[string, string]> = [
    ["0.0.0.0", "0.255.255.255"], ["10.0.0.0", "10.255.255.255"], ["100.64.0.0", "100.127.255.255"],
    ["127.0.0.0", "127.255.255.255"], ["169.254.0.0", "169.254.255.255"], ["172.16.0.0", "172.31.255.255"],
    ["192.0.0.0", "192.0.0.255"], ["192.0.2.0", "192.0.2.255"], ["192.88.99.0", "192.88.99.255"],
    ["192.168.0.0", "192.168.255.255"], ["198.18.0.0", "198.19.255.255"], ["198.51.100.0", "198.51.100.255"],
    ["203.0.113.0", "203.0.113.255"], ["224.0.0.0", "239.255.255.255"], ["240.0.0.0", "255.255.255.255"],
  ];
  for (const [lo, hi] of table) {
    it(`blocks ${lo} – ${hi}`, () => { blocked(lo); blocked(hi); });
  }
  it("allows the addresses just outside each range", () => {
    for (const ip of ["9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0",
      "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0", "192.0.1.0", "192.169.0.0", "192.167.255.255",
      "198.17.255.255", "198.20.0.0", "223.255.255.255", "8.8.8.8", "140.82.112.3", "185.199.108.133"]) allowed(ip);
  });
});

describe("IPv6 special-use ranges", () => {
  it("blocks loopback, unspecified, ULA, link-local, multicast, documentation, discard", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd00::1", "fdff:ffff::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff00::",
      "2001:db8::1", "2001:db8:ffff::1", "3fff::1", "100::1", "2001::1", "2001:10::1", "2001:20::1", "2002::1:1"]) blocked(ip);
  });
  it("blocks IPv4-mapped, compatible, NAT64, 6to4 and Teredo forms that embed a private IPv4", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
      "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::169.254.169.254", "2002:7f00:1::1", "2002:a00:1::1", "2002:c0a8:101::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b:1::1"]) blocked(ip);
  });
  it("blocks mapped public IPv4 as well (no legitimate use for mapped forms in a destination)", () => {
    blocked("::ffff:8.8.8.8");
  });
  it("allows ordinary global unicast addresses", () => {
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2001:4860:4860::8888", "2620:0:860:2::1"]) allowed(ip);
  });
  it("reports a specific reason for the ranges that matter (so a regression in one rule is visible even though default-deny still blocks)", () => {
    expect(classifyAddress("fd00::1").reason).toBe("unique-local");
    expect(classifyAddress("fe80::1").reason).toBe("link-local");
    expect(classifyAddress("::1").reason).toBe("loopback");
    expect(classifyAddress("::ffff:10.0.0.1").reason).toBe("ipv4-mapped");
    expect(classifyAddress("169.254.169.254").reason).toBe("link-local");
  });
  it("handles zone ids and case", () => {
    blocked("FE80::1%eth0"); blocked("FD00::A"); allowed("2606:4700:4700::1111");
  });
});

describe("non-canonical IPv4 spellings are never treated as public", () => {
  it("rejects strings that are not canonical dotted decimal or IPv6", () => {
    for (const s of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "127.0.0.1.", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "", " 1.2.3.4", "1.2.3.4 ", "not-an-ip"]) {
      expect(classifyAddress(s).kind, s).toBe("invalid");
      blocked(s);
    }
  });
});

describe("hostname policy", () => {
  it("normalises case, trailing dot and IDNA", () => {
    expect(normalizeHostname("GitHub.COM.")).toBe("github.com");
    expect(normalizeHostname("github.com")).toBe("github.com");
  });
  it("rejects every IP literal form, including bracketed IPv6 and numeric hosts", () => {
    for (const h of ["127.0.0.1", "[::1]", "::1", "[fd00::1]", "[fe80::1]", "[::ffff:7f00:1]", "[2606:4700:4700::1111]", "8.8.8.8", "2130706433", "0x7f.1", "1.2.3"]) {
      const r = assessHostname(h);
      expect(r.ok, h).toBe(false);
      expect(r.ok ? "" : r.reason, h).toBe("IP literal");
    }
  });
  it("rejects local, internal and metadata names, with or without trailing dot", () => {
    for (const h of ["localhost", "localhost.", "LOCALHOST", "foo.localhost", "foo.local", "foo.internal", "metadata.google.internal", "metadata.google.internal.",
      "instance-data", "intranet", "printer", "foo.home.arpa", "foo.lan", "foo.corp", "foo.intranet", "foo.localdomain", "foo.test", "foo.invalid", "foo.example", "foo.onion", "in-addr.arpa", "1.0.0.127.in-addr.arpa", "x.ip6.arpa"]) {
      expect(assessHostname(h).ok, h).toBe(false);
    }
  });
  it("rejects malformed names", () => {
    for (const h of ["", ".", "a..b", "-a.com", "a-.com", "a b.com", "a_b.com".replace("_", "\u0000"), "a/b.com", "a@b.com", "a:80.com", "x".repeat(64) + ".com", ("a.".repeat(130)) + "com"]) {
      expect(assessHostname(h).ok, JSON.stringify(h)).toBe(false);
    }
  });
  it("accepts ordinary public names", () => {
    for (const h of ["github.com", "api.github.com", "raw.githubusercontent.com", "x.com", "example.org", "sub.domain.example.co.uk"]) {
      expect(assessHostname(h).ok, h).toBe(true);
    }
  });
});
