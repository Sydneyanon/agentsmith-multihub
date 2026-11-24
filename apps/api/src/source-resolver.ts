import { isIP } from "node:net";

export type SourceReference = {
  submittedUrl: string;
  canonicalUrl: string;
  host: string;
  kind: "github_repository" | "github_file_or_directory" | "x_post" | "web_page";
  repository?: { owner: string; name: string; url: string };
};

/**
 * Parse a submitted public reference without making a network request.
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
  if (!url.hostname || isIP(url.hostname) !== 0 || url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") || url.hostname === "127.0.0.1" ||
      url.hostname === "::1" || url.hostname.startsWith("10.") ||
      url.hostname.startsWith("192.168.") || url.hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) {
    throw new Error("Local and private-network URLs are not accepted");
  }

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
