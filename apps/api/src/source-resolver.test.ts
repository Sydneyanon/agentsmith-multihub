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
});
