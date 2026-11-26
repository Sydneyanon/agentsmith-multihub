# Official-source research for discovery adapters (2026-11-26)

Method: official pages fetched through the session's web-fetch path (not scraped, no bulk content kept). Only facts read on an official page are listed as VERIFIED.
Supersedes the secondary-source column of section D in `pr20-review-and-next-steps.md` where they differ. **No adapter is approved or built for any platform below.**

| Platform | VERIFIED on official pages | NOT established |
|---|---|---|
| Immunefi | Terms of Use (modified 2023-04-11), section 4 forbids using "any robot, spider, or other similar automatic device, process, or means to access the Website for any purpose" and use that could "overburden" the site; the Rules page forbids "Automated testing of services that generates significant amounts of traffic". robots.txt is `Allow: /` with no Disallow. `immunefi.com/public-api/bounties.json` answers HTTP 200 JSON (~6.3 MB, one array of programs with fields such as `slug`, `project`, `maxBounty`, `launchDate`, `endDate`, `updatedDate`, `githubUrl`, `isPaused`, `assets`, `inviteOnly`). | The endpoint is **not documented** on any page read, so it is not shown to be an official API. The Terms' robot clause, read literally, covers the website; whether it covers this JSON file is a legal/ownership question, not a technical one. About 16,000 characters of the Terms were not read verbatim. **Recommendation: do not build an adapter unless Immunefi confirms in writing that this file may be polled (ask them), because the Terms on their face prohibit automated access.** |
| HackenProof | robots.txt is `Allow: /`. Terms link redirects to a PDF on S3 that the fetcher could not read (over 10 MB). | Terms text unread; no API or feed found. The owner should read the PDF directly. No adapter. |
| Sherlock | `audits.sherlock.xyz/robots.txt` disallows nothing. | `docs.sherlock.xyz` and `sherlock.xyz` did not resolve from this environment, so no docs, terms or API statement was read. Whether contests still run is unconfirmed. |
| Code4rena | `code4rena.com/robots.txt` is `Allow: /`. Its public GitHub organisation works with the existing adapter. | `docs.code4rena.com` did not resolve; no platform terms read. The GitHub path needs only GitHub's own terms/API limits (verify live). |
| Cantina | `cantina.xyz/terms` redirects to `www.cantina.security/terms`, which did not resolve. | Terms and `docs.cantina.xyz` unread here. Earlier search results (secondary) say its REST API is for client organisations. |
| X | Not researched further (not approved). | Paid API; separate cost/value assessment required. |

## Consequences
- The only source with a verified permissible path is **GitHub organisations through GitHub's documented API** (Code4rena first). That is what 5.0 implements.
- Platform-site adapters stay unbuilt. Immunefi is the sharpest case: useful data exists but the stated terms prohibit automated access; permission must be obtained, not assumed.
- Fetch failures were DNS failures in this sandbox's allowlist, not evidence about the sites. Hosts to allow, if the owner wants this continued here: docs.sherlock.xyz, sherlock.xyz, docs.code4rena.com, docs.cantina.xyz, www.cantina.security, docs.hackenproof.com. Or the owner can read those terms directly.
