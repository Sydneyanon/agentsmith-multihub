import { assessHostname } from "./net/ip-policy.js";

export type SourceReference = {
  submittedUrl: string;
  canonicalUrl: string;
  host: string;
  kind: "github_repository" | "github_file_or_directory" | "x_post" | "web_page";
  repository?: { owner: string; name: string; url: string };
};

/**
 * Parse a submitted public reference without making a network request.
 * This is the first of two layers: it rejects names that can never be public targets.
 * The second layer is net/safe-fetch, which validates the actual resolved address at connect time —
 * a name that passes here can still resolve to a private address, and only the second layer can see that.
 * Fetching and crawling are separate worker capabilities with their own
 * redirect, DNS, size, timeout and host-safety controls.
 */
export function resolveSourceReference(raw: string): SourceReference {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Source must be a valid absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS source URLs are accepted");
  }
  if (url.username || url.password) throw new Error("URLs containing credentials are not accepted");
  const assessed = assessHostname(url.hostname);
  if (!assessed.ok) throw new Error(`Local, private-network and IP-literal URLs are not accepted (${assessed.reason})`);
  // WHATWG parsing drops a scheme's default port, so any remaining port is a non-default one.
  if (url.port !== "") throw new Error("URLs with a non-default port are not accepted");
  url.hostname = assessed.hostname; // canonical: lower-case, no trailing dot, punycode

  url.hash = "";
  const host = url.hostname.toLowerCase();
  const canonicalUrl = url.toString();

  if (host === "github.com" || host === "www.github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0]!;
      const name = parts[1]!.replace(/\.git$/i, "");
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) ||
          !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || owner === "." || name === ".") {
        throw new Error("GitHub URL does not contain a valid repository path");
      }
      const repositoryUrl = `https://github.com/${owner}/${name}`;
      return {
        submittedUrl: raw,
        canonicalUrl,
        host: "github.com",
        kind: parts.length > 2 ? "github_file_or_directory" : "github_repository",
        repository: { owner, name, url: repositoryUrl },
      };
    }
  }

  if (host === "x.com" || host === "www.x.com" || host === "twitter.com" || host === "www.twitter.com") {
    return { submittedUrl: raw, canonicalUrl, host, kind: "x_post" };
  }
  return { submittedUrl: raw, canonicalUrl, host, kind: "web_page" };
}
