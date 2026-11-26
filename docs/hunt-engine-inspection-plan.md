# Establishing whether the Hunt engine still polls Immunefi (S4): inspection plan

Status: **plan only. Nothing here has been done.** No Linode access, no request to the Hunt service, no change to it, and no secret has been read. Each step needs the owner's explicit go-ahead.

## Why this is risky
The deployed bundle was assembled with the engine's admin token (and a server bootstrap) embedded in its delivery artefacts. Anything that reads the server, its volume, its StackScript, its instance user-data or its configuration files could expose that token or other secrets. The plan therefore avoids those surfaces entirely and uses the least intrusive evidence first.

## Evidence ladder (stop as soon as the question is answered)
| Step | What it shows | What it touches | Secret exposure |
|---|---|---|---|
| 1. Owner looks at the Hunt page in their own browser | the public status board's scout block: "scout on duty" flag, last sweep time, and recent scout events. A last-sweep time after 2026-11-23 shows sweeps are running. | the public page the owner already operates | none (public, no token) |
| 2. Owner checks the Linode dashboard | whether the instance is running or powered off, and its last reboot | owner's own console | none |
| 3. (Needs approval) one unauthenticated GET of the public `status.json` by me | the same scout block as step 1, machine-readable | the Hunt service's public endpoint; one request; no token header | none; I send no credential |
| 4. (Needs approval) Linode API **instance list metadata only**, via the connected credential | instance label, status, created and updated times, region | only `GET /v4/linode/instances`, printing an allowlist of those fields | none if the allowlist is respected. **Never** call StackScript, config, disk, volume, metadata/user-data or backup endpoints, which can contain the token. |
| 5. (Only if 1-4 are inconclusive; owner-run) a read-only command on the server, e.g. showing the scout service's recent log lines that name the sources and times | which sources were read and when | owner runs it; owner pastes **redacted** output | I never receive the token, secrets file or environment; the owner removes anything token-like before pasting |

## Rules for any inspection
- Print only an allowlist of fields; do not dump responses, files or logs.
- Never open the engine's secrets file, admin token, `.env`, bootstrap/user-data, StackScript bodies or database.
- Do not write any inspected content into the repository.
- If a secret appears anyway: stop, do not repeat or store it, tell the owner immediately and recommend rotation.
- No pause, restart, reconfiguration or deletion of the Hunt service without the owner's explicit approval.
- Results: the answer to "is it polling Immunefi" is recorded as one of: confirmed polling (with evidence), no evidence of polling, or not determinable; with the evidence step that produced it.

## What each outcome means
| Outcome | Consequence |
|---|---|
| Instance off, or last sweep stale | No current polling from Hunt; S4 downgrades to historical; the owner may still wish to disable its Immunefi source before restarting it |
| Sweeps recent and Immunefi is a configured source | Polling is happening now; the owner decides whether to pause that source pending the permission route (T-022); MultiHub does not add a second poller |
| Not determinable | Owner-run step 5, or accept the uncertainty and disable the source from the owner's side |
