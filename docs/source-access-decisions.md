# Bounty source access: audit and the decisions that are yours

The goal is automatic coverage of our established sources, with no manual data entry for platforms we already know. This audits each
adapter, states what is already running, and lists the few permission decisions that genuinely need you. Access facts were checked
live on 2026-11-27.

## First, the thing that is easy to miss

**The community board already aggregates all four platforms automatically** and is live in production, refreshed hourly:

| On the board now | Immunefi | Cantina | Sherlock | HackenProof |
|---|---|---|---|---|
| Programmes | 143 | 46 | 41 | 158 |

So you are **not** doing manual entry for these platforms — their programmes already appear (388 total), as **community reports**. What
the board cannot give is *official confirmation* and *verified scope* (the real in-scope repositories). That is what direct collection
from each platform adds, and that is where the permission decisions sit.

## Adapter audit

| Source | Adapter | Live access finding (2026-11-27) | State |
|---|---|---|---|
| Community board | built, **enabled** | published `programs.json`; robots.txt absent | running hourly |
| Sherlock | built, tested | `audits.sherlock.xyz/robots.txt` disallows nothing; no terms page exists (sherlock.xyz/terms and audits.sherlock.xyz/terms both 404) | **off — owner decision** |
| HackenProof | built, tested | `robots.txt: Allow: /`. Terms grant a personal-use licence and forbid reproducing/publishing Content without written permission | **off — owner decision** |
| Immunefi | **built this round, tested, disabled** | `robots.txt` is now `Allow: /` (no Disallow). `immunefi.com/public-api/bounties.json` returns 200, `cache-control: public`, 216 programmes, named "public-api". **But** the Terms of Use (section 4, read 2026-11-26) forbid robots/automated access to "the Website" | **off — owner decision** |
| Cantina | blocked | listing is rendered in the browser from `/api/`, which `robots.txt` disallows (`Disallow: /api/`). No permitted automated method found | **blocked — no decision available** |

The Immunefi public-api is rich: official URL, reward, currency, chains, asset types, invite-only/paused status, and the **in-scope
asset URLs including GitHub repositories** (Compound 1 repo, Rootstock 6, Optimism 5 in the sample). That is verified scope the engine
needs. The adapter is built and parse-tested against the real response, but the source stays disabled; it is never enabled by code.

## What is implemented now (already authorised or safe to prepare)

- The **community board** keeps running (no change).
- **Manual URL import** stays, for a genuinely missing opportunity only.
- An **eligibility classifier** now separates a collected lead from a programme AgentSmith can hunt: `eligible` (officially confirmed +
  smart-contract scope + reward), `needs_verification` (candidate), `out_of_engine_scope` (web/app only or no official URL),
  `ineligible` (recovery bounty / no reward). Surfaced on the dashboard and at `GET /v1/bounties/candidates`.
- A one-call **operator control** to act on your decisions: `POST /v1/bounties/sources/<key>/enable` (and `/disable`), bearer-protected.
  It **refuses to enable a blocked source** (Cantina), so a decision can never be applied by mistake.
- The **Immunefi adapter**, built and tested, shipped **disabled**.

None of this is deployed yet — it is on the branch, verified. Enabling any source in production ships in a follow-up deploy you approve
(the enable control and the Immunefi adapter are new code; Sherlock/HackenProof adapters are already in the deployed image but the
enable control is not).

## The decisions that need you

Each is a yes/no. On a yes, enabling is one authenticated call; nothing is enabled until you say so.

1. **Sherlock — enable direct collection?** robots.txt permits it and no terms forbid it. One request/hour reads the public listing.
   - *Recommendation: yes.* Low risk; confirms ~41 programmes officially, with real scope.
2. **HackenProof — enable direct collection?** Two parts, because their terms restrict republishing:
   - (a) **Collect for internal use** (feed the engine, operator views): their terms permit personal use. *Recommendation: yes.*
   - (b) **Display HackenProof programme details on the public page?** Their terms forbid reproducing/publishing Content without written
     permission. *Recommendation: no, unless you obtain their permission* — collect internally, keep it off the public page.
3. **Immunefi — read the `public-api/bounties.json` endpoint?** robots.txt now allows it and it is literally a "public-api" with public
   caching, which points to intended consumption; but the Terms of Use broadly forbid automated access to the Website, which conflicts.
   - *Recommendation: a one-line confirmation from Immunefi that the public-api endpoint may be polled, then enable.* It is the single
     highest-value source (143 programmes, official status, verified repos). I did not enable it on the strength of the endpoint name alone.
4. **Cantina — no action available.** No permitted automated method exists; it stays covered via the community board. Only pursue if you
   obtain API access or written permission from Cantina.

## What enabling each would change (automatic, no manual entry)

| Decision | On "yes" | Effect |
|---|---|---|
| Sherlock | one enable call + follow-up deploy | ~41 programmes move from "community report" to "official confirmed", with verified scope; refreshed hourly |
| HackenProof (collect) | one enable call + follow-up deploy | ~158 programmes confirmable internally; ~35 pages every 6 hours |
| Immunefi | confirm terms, then one enable call + deploy of the new adapter | ~143 programmes officially confirmed with in-scope GitHub repositories — the richest path to engine-eligible targets |

Enabling Sherlock + Immunefi would, by itself, turn a large share of the 388 from leads into officially-confirmed, engine-eligible
programmes — which is the real answer to "how many can AgentSmith legitimately hunt."
