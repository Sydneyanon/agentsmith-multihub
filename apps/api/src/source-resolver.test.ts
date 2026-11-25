import { describe, expect, it } from "vitest";
import { resolveSourceReference } from "./source-resolver.js";

describe("source reference resolver", () => {
  it("extracts a GitHub repository from repository and file URLs", () => {
    const repo = resolveSourceReference("https://github.com/acme/protocol");
    expect(repo.kind).toBe("github_repository");
    expect(repo.repository).toEqual({
      owner: "acme",
      name: "protocol",
      url: "https://github.com/acme/protocol",
    });
    const file = resolveSourceReference("https://github.com/acme/protocol/blob/main/src/vault.sol");
    expect(file.kind).toBe("github_file_or_directory");
  });

  it("classifies X links without fetching them", () => {
    expect(resolveSourceReference("https://x.com/security/status/123").kind).toBe("x_post");
  });

  it("strips fragments from canonical references", () => {
    expect(resolveSourceReference("https://example.org/page#section").canonicalUrl)
      .toBe("https://example.org/page");
  });

  it("rejects unsafe schemes, credentials and private network targets", () => {
    expect(() => resolveSourceReference("file:///etc/passwd")).toThrow();
    expect(() => resolveSourceReference("https://user:pass@example.org")).toThrow();
    expect(() => resolveSourceReference("http://127.0.0.1/admin")).toThrow();
    expect(() => resolveSourceReference("http://192.168.1.5/")).toThrow();
  });

  it("rejects every IP-literal and internal-name form, not just the obvious ones", () => {
    const bad = [
      "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:7f00:1]/", "http://[2606:4700:4700::1111]/",
      "http://localhost./", "http://LOCALHOST/", "http://metadata.google.internal/", "http://metadata.google.internal./computeMetadata/v1/",
      "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/", "http://100.64.0.1/", "http://169.254.169.254/latest/meta-data/",
      "http://0.0.0.0/", "http://printer/", "http://intranet/", "http://foo.internal/", "http://foo.home.arpa/", "http://8.8.8.8/",
      "https://github.com:8443/acme/protocol", "http://example.org:22/", "https://example.org:6379/",
    ];
    for (const u of bad) expect(() => resolveSourceReference(u), u).toThrow();
  });
  it("still accepts ordinary public names on the default port, including http", () => {
    expect(resolveSourceReference("https://example.org/page").kind).toBe("web_page");
    expect(resolveSourceReference("https://example.org:443/page").kind).toBe("web_page");
    expect(resolveSourceReference("http://example.org/page").kind).toBe("web_page");
    expect(resolveSourceReference("https://GitHub.com./acme/protocol").repository?.owner).toBe("acme");
  });
});
