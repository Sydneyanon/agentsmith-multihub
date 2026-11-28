# Multi-domain security research (strategic workstream, recorded 2026-11-26)

Status: **long-term architectural commitment. Planning only; not authorised for implementation.** Smart-contract security remains the immediate focus. No domain beyond it is built until a credible, independently evaluated smart-contract research engine exists.

## 1. Principle
One research kernel, many domain packs. The kernel is shared; each domain brings its own threat model, artifacts, analyzers, tools and validation methods. **A Solidity analyzer is not assumed reusable for Web2**: parsers, semantics, trust models, oracles of correctness and safe validation methods differ.

## 2. Shared kernel (all domains)
Opportunity discovery; priority management; repository and artifact acquisition; provenance and evidence; hypothesis management; independent challenge; durable research memory; learning and evaluation; professional reporting; orchestration and the Control Room.
Generalisations the kernel needs (T-170): "snapshot" from repository snapshot to **artifact snapshot** (repositories, API specifications, configuration exports, dependency manifests, build definitions); "evidence span" from file lines to **typed evidence locators** (file range, HTTP exchange record, configuration path, dependency edge); domain-tagged hypothesis families; domain-specific challenge methods behind a common interface; domain-aware authorisation policy.

## 3. Domain pack interface (T-171)
A domain pack declares: threat model; artifact types and acquisition adapters; analyzers and tools; hypothesis families; validation methods and oracles; evidence locator kinds; reporting templates; **safety and authorisation policy** (what may be done passively, what needs verified scope and approval, rate limits, sandboxing); evaluation corpora requirements.

## 4. Domains
| Domain | Status | Scope | Validation character |
|---|---|---|---|
| **Smart contracts** | **Immediate focus** | Solidity/EVM: DeFi, lending and borrowing, vaults, bridges, oracles, governance, token systems, cross-contract economics and business logic | Local compilation and execution is safe and available: the strongest validation of any domain |
| Web application | Future (first expansion) | Authentication, authorisation, session management, access-control failures, business logic, privilege escalation, trust-boundary violations | Source review is passive; dynamic validation means **active testing**, which needs verified scope, authorisation, rate limits and sandboxed own instances |
| API | Future | BOLA, BFLA, authentication weaknesses, API business-logic flaws, privilege escalation, unsafe integrations and data exposure | OpenAPI and code review passive; validation against owned test instances |
| Cloud and infrastructure | Future | Identity and permissions, misconfiguration, insecure storage, exposed services, trust boundaries, architecture and integration weaknesses | Infrastructure-as-code and exported configuration analysed passively; no live probing without authorisation |
| Software supply chain | Future | Dependency vulnerabilities, insecure packages, build and deployment processes, dependency confusion and substitution, compromised update mechanisms, trust across components | Manifest and build-definition analysis passive; reproducible-build checks in sandbox |
| Identity systems | Future | Authentication flows, authorisation boundaries, identity lifecycle, token and credential handling, privilege relationships, federation and trust failures | Specification and implementation review; protocol-flow modelling; active tests only with authorisation |

## 5. Expansion sequence (each step gated by measured value)
1. Establish a credible, independently evaluated smart-contract research engine (the current work plus APEX).
2. Generalise the shared kernel interfaces (T-170, T-171).
3. Research and design the Web2 domain architecture (T-172).
4. Build a **limited** Web2 proof of capability (T-173), passive first.
5. Evaluate it independently on a frozen, independently authored corpus (T-174).
6. Expand into API, cloud, identity and supply chain according to measured value and owner decision (T-175 to T-178), with an explicit review (T-179).

## 6. Boundaries
No domain is added by assumption. No active testing of any live system in any domain without verified scope and authorisation (`ROADMAP.md` 2G). Web2 and cloud work raise the stakes of authorisation, rate limits and data handling; they are designed before they are built. No credentials, customer data or personal data are stored beyond what a verified, authorised engagement requires.

## 7. Acceptance for the workstream
A domain is "operational" only when it has: a documented threat model; a domain pack; at least one independently authored held-out corpus with labels checked by a method other than the analyzer; a measured comparison against conventional tools for that domain; a safe validation method; and a reviewed authorisation policy.
