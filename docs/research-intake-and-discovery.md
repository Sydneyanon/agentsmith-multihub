# Research Intake and Autonomous Discovery

## Product requirement

The operator can submit a single URL (for example an X post, GitHub repository, protocol website, audit report or documentation page) and the platform takes responsibility for the research workflow. The operator should not need to manually locate source code, construct checklists or direct each investigation step.

The platform also runs bounded discovery jobs against permitted public sources and feeds candidates into the same intake pipeline.

## Intake sources

- X posts and public project announcements
- GitHub repositories, organizations, releases and commit links
- Project and protocol websites
- Public documentation and technical papers
- Audit reports and disclosed post-mortems
- Bug bounty program pages and scope documents

Every intake item stores the submitted URL, canonical URL, source type, retrieval time, source snapshot or content hash, and provenance. Unavailable or inaccessible sources are marked as such; the system must not invent their contents.

## URL-to-investigation workflow

1. **Resolve:** safely classify the URL, follow permitted redirects, canonicalize it and record provenance.
2. **Extract context:** identify project, organization, protocol, relevant announcement, repository links, documentation and claimed technology.
3. **Discover code:** locate official source repositories and relevant branches, tags, releases and recent commits. Record why a repository is believed to be official.
4. **Resolve authorization:** find the relevant bug bounty or security policy, capture scope and exclusions, allowed testing, rate limits and dates. If authorization is unclear, permit passive source review only and block active testing.
5. **Build project map:** identify languages, frameworks, entry points, privileged roles, trust boundaries, assets, core state transitions and critical invariants.
6. **Apply gold-standard checks:** select checklist versions based on the project's technology and architecture. Record which checks ran, were skipped or were not applicable.
7. **Generate hypotheses:** specialist investigators propose code locations, attack paths, preconditions and expected impact. Hypotheses must cite exact source locations and remain explicitly unverified.
8. **Test safely:** run static analysis and local tests first. Any live or state-changing test requires explicit scope authorization and the applicable approval.
9. **Independent judge:** a separate reviewer challenges each candidate, checks reproduction, tests alternative explanations and records a verdict.
10. **Report and learn:** prepare a draft report only for supported findings; record false positives, gaps and new checklist candidates with provenance.

## Autonomous discovery

Discovery jobs can monitor configured public sources for new projects, releases, audits, program changes and security-relevant announcements. Discovery produces candidate intake records; it does not itself authorize testing.

Each candidate is deduplicated by canonical URL, repository identity and content hash. Candidates receive a transparent priority score based on source credibility, program authorization, code availability, project relevance and research novelty. The score is a queue-ordering aid, not a vulnerability verdict.

## X integration boundary

X is one discovery source, not a dependency of the core platform. Use an approved API or permitted public access method, respecting platform terms, rate limits and access restrictions. Store source IDs and links where available. If access is unavailable or too expensive, the manual URL inbox and alternative public sources continue to work.

## Operator experience

The dashboard should provide:
- a single URL submission box;
- a live timeline of what the system discovered and did;
- links to repositories, source snapshots and evidence;
- checklist coverage and skipped-check reasons;
- candidate findings with confidence and independent-review status;
- spend and model usage for each workflow;
- pause, cancel and approval controls.

## Non-negotiable safeguards

- Never treat an X post, repository link or project claim as proof of authorization.
- Never expand scope based on inferred ownership or linked domains.
- Never perform intrusive testing merely because a target was discovered.
- Never label an AI-generated hypothesis as a confirmed vulnerability.
- Preserve source provenance and exact versions so investigations can be reproduced.
