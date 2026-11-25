# X bounty-link intake: retained core requirement

Status: requirement and placement only. Nothing here is implemented, and nothing here authorises active testing, external contact or any submission.

## The product requirement
The operator pastes an X link to a bounty, contest or audit announcement. The system turns it into a **structured research job**:
1. Extract the project, the program or contest, scope statements, deadlines and requirements from the announcement and the pages it links to.
2. Verify the **official** project and its repositories (never trust the post alone: official-ness needs corroboration such as the project's own site linking back, and a human confirmation).
3. Create a research job with provenance for every extracted field (which URL, when, what exactly was read), ready for the research pipeline.

## Where it sits in the existing architecture and roadmap
- **Intake already classifies X links** without fetching them (`resolveSourceReference` returns `x_post`; the intake `source` enum already includes `x`). The workflow stays passive and `execution_mode: passive_only`; `authorization_status` stays `unverified` until a human confirms scope.
- **Task 5.3 (Discover)** owns it: fetching the announcement and linked pages through the hardened fetcher (SSRF controls, DNS and redirect rules), extracting the structured fields, proposing candidate official repositories with explicit signals and reasons, and parking the result at `awaiting_approval` for human confirmation ("never official without a human").
- **Fetching X content is the open design question** and needs its own reviewed decision before 5.3 builds it: X content is login-walled and rate-limited, the official API is paid, and scraping may violate terms. Options to evaluate: the owner pastes the post text alongside the link; a user-supplied export; a paid API only if budget policy allows (the AI and spend boundaries still apply). Until decided, the link is recorded and classified, never silently fetched.
- **Dashboard:** the Projects screen already creates a project from a pasted link through `POST /v1/intake`; the extracted fields, their provenance and the verification state will appear there once 5.3 writes them. The dashboard shows only what the backend records.

## Boundaries that stay in force
Scope guard and authorization gate apply: extracted scope is a claim to be confirmed, not permission. No active testing, no contact with the project, no external submission is authorised by this feature.
