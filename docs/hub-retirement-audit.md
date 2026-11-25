# Old hub audit and retirement list (NOTHING DELETED, NOTHING YET IDENTIFIED AS OBSOLETE)

Date: 2026-11-25. Rule applied: a resource is listed for retirement only after it is positively identified as belonging exclusively to the obsolete hub. **No resource meets that bar yet**, because the systems that would show it could not be read from this session. The list below is therefore an honest inventory of what is known, what is not, and the exact read-only steps that close the gap. No deletion is proposed.

## What could and could not be inspected
| Source | Result |
|---|---|
| GitHub repository and PRs #1 to #9 (all draft, unmerged) | Read. The repository contains no old-hub deployment, only the Fly configs below. |
| Fly.io account (apps, machines, volumes, databases, certificates, secrets) | **Not inspected.** No Fly credential exists in this session; `flyctl` was never run against an account. |
| Linode account | **Not inspected.** The proxy-injected token was rejected (`{"errors":[{"reason":"Invalid Token"}]}`), so nothing was listed. Please re-issue or reconnect the credential if the old hub may live there. |
| DNS zone for `agentsmithdesk.xyz` | **Not inspected.** The DNS provider is unknown to this session and its resolver is filtered (control names such as `example.com` return "no such domain"), so its answers cannot be used as evidence. The single answer it gave, `hunt.agentsmithdesk.xyz` = `194.195.254.216`, is therefore unverified, and it does not match GitHub Pages addresses even though `docs/existing-hunt-board-integration.md` says the Hunt dashboard is served from GitHub Pages: a discrepancy to resolve with the real zone. |
| Live hosts `hub.` and `hunt.agentsmithdesk.xyz` | Not reachable from this session's network policy; not requested. |
| Root page `https://agentsmithdesk.xyz` | Host allowed at the owner's request; the fetch still failed (TLS handshake refused from this session; the page-fetch tool reported the name not found). Not needed: the hub uses only the `hub` subdomain, which the owner has confirmed as permanent. |

## Known candidates (none confirmed obsolete)
| Resource or record | Exact identifier | What it does (known) | New hub depends on it? | Could removal affect Hunt or another service? | Status |
|---|---|---|---|---|---|
| Fly app named in `fly.toml` | `agentsmith-multihub` | The file calls it "the existing app" and forbids deploying with that file without `--app`. Contents and purpose unknown. It may be this project's earlier backend, an old hub, or something with data. | **No.** The new hub uses a separate proposed app, `agentsmith-hub`. | Unknown. Could hold production secrets, a database attachment or the only copy of data. | **Unidentified. Do not delete.** |
| Fly app named in staging configs | `agentsmith-multihub-staging` | Prepared and documented in `docs/fly-staging-runbook.md`; whether it was ever created is unknown (the owner declined the staging deployment earlier). | No | Unknown | **Unidentified. Likely never created.** |
| DNS record(s) named `hub` | `hub.agentsmithdesk.xyz` | Unknown: no record could be read. | The new hub needs exactly this name, so a stale record here must be replaced, not kept. | Only if it is shared with another service. | **Unidentified.** |
| Hunt dashboard | `hunt.agentsmithdesk.xyz`, repository `Sydneyanon/hunt` | Public dashboard, separate repository. | No | n/a | **Out of scope. Not to be touched.** |
| Root domain, `www`, MX, SPF, DKIM, DMARC, all other records | n/a | Unknown, deliberately untouched. | No | Yes, never edited. | **Out of scope.** |

## Dependencies the new hub still needs from anything existing
None identified. The new hub needs its own app, its own database, its own token and one new DNS name. It does not read the Hunt site, the old Fly app, or any existing database. If the owner wants the old app's data (for example earlier intake runs), that is a separate migration decision, not an assumption.

## Read-only inventory the owner can run (shows exactly what exists; nothing here changes anything)
Fly (names and settings only; never paste a secret value):
- `fly apps list`
- for each app: `fly status --app NAME`, `fly machines list --app NAME`, `fly ips list --app NAME`, `fly certs list --app NAME`, `fly volumes list --app NAME`, `fly secrets list --app NAME` (names only), `fly releases --app NAME`
- databases: `fly mpg list` and, for legacy clusters, `fly postgres list` (verify command names against current flyctl)
- billing view of what is running: the Fly dashboard, Billing, current usage

DNS: an export or screenshot of the full zone for `agentsmithdesk.xyz` from the DNS provider (and the provider's name), including every record named `hub`.

Linode, only if the old hub may be there: re-issue the connected token, or list Linodes, volumes, NodeBalancers, databases and object storage from the Linode console.

## Retirement list format (to be filled in and approved item by item)
For each proposed removal, before anything is deleted: exact name or id, what it does today, proof it belongs only to the old hub (for example, the app serves only a hub hostname, nothing else attaches to its database), whether the new hub depends on it (no), what could break if it is wrong (especially Hunt), and the replacement. Deletion order, when approved: DNS record last-used first, then certificates, then the app, then volumes and databases only after a backup is confirmed restorable. Databases and volumes are never deleted in the same step as the app.
