# Bounty intelligence → hunting engine: what is connected

This records how the bounty collection subsystem (migration 0011) relates to the existing research/hunting engine, what has been
**demonstrated end to end**, and the guardrails that are deliberately kept in place. It is not a proposal; the demonstrations below ran.

## The two systems and the bridge

- **Bounty intelligence (Workstream A):** collects, deduplicates, verifies and ranks public programmes. It is read-only intelligence;
  it never investigates. Its ranking (`bounty-rank/1`) scores reward attractiveness, credibility, suitability, completeness and
  freshness, and it never ranks by maximum reward alone.
- **Hunting engine (existing):** the research loop in `apps/api/src/engine/`. A programme becomes an investigation only through the
  recorded chain **register → verify → rank → select → acquire → map → investigate → challenge → ingest**, every step persisted.
- **The bridge is the engine's opportunity registry.** A bounty programme enters the engine exactly as any opportunity does:
  as a registered opportunity whose repository, scope and eligibility are **verified by a human** before any acquisition. The
  bounty system supplies the candidate and its claimed facts; it supplies no authorization. "Never official without a human" is the
  gate, and it is unchanged.

## What has actually run (2026-11-27, local)

**Full chain on a controlled target** (`eval/hunting/controlled-reentrancy/README.md`): the engine CLI drove
register → verify → rank → select → acquire + seal → map → investigate → challenge → ingest on the DeFiVulnLabs `EtherStore`
reentrancy, on a disposable Postgres with the drafts applied and the **real** pinned tools.

- The structural analyser and **Slither 0.11.3** independently flagged `EtherStore.withdrawFunds`; a deterministic evaluator
  **supported** both; a **Foundry 1.5.1** PoC reproduced the full drain and confirmed the remediated version is safe.
- Evidence (hypotheses, evidence spans, evaluations) is persisted in the existing research store.
- False positives were eliminated: the remediated function was cleared by every method, and the corpus-wide scanner noise
  (56 raw leads, mostly test `setUp()` and attacker contracts) was not promoted to findings.

This is the answer to "can AgentSmith find bugs, not just run scanners": three independent methods plus a reproduction, on a target
with known ground truth, through the existing infrastructure. It is **exposure-qualified** (a known textbook bug), exactly like the
Ethernaut cycle.

## Prioritisation (implemented, in the engine)

`rankOpportunities` already scores every open opportunity with the T-051 priority engine and records **why** each one ranks where it
does (features and contributions, stored on a decision). It uses the protocol model's components and the research-coverage memory, not
reward alone. A bounty programme routed into the registry is ranked by this same explainable policy.

## What is deliberately NOT enabled

These are not missing work; they are gates the project set, and this integration keeps them:

1. **No autonomous investigation of live third-party bounty programmes.** The controlled demonstration used an intentionally
   vulnerable educational repo. Investigating a real protocol needs: human scope/eligibility verification (in the chain), the
   production research cycle proven first (the Ethernaut cycle, A26/A34), and R1. None of that is bypassed.
2. **No unattended autonomous loop and no submissions.** The engine advances one recorded step at a time; selection and adjudication
   are human decisions. Nothing drafts or sends a disclosure to a programme.
3. **No AI runtime.** The pipeline above is fully deterministic (structural analysis + Slither + Foundry + deterministic evaluators).
   No model is called. A31 (paid model runtime) is not approved and is not used; there is no Grok integration and none is invented.
4. **Scope and safety.** Active, destructive or on-chain testing is not performed. Analysis is passive source reading and local,
   sandboxed reproduction (the tool host spawns only the pinned tools, and is excluded from the deployed image).
5. **Budget.** No AI spend is incurred. The $25/month ceiling and A31 remain untouched.

## The smallest next step to real hunting in production

The chain is proven locally. To run it against a **real** approved programme needs, in order: A42 (deploy the bounty page), then the
Ethernaut production cycle (R1-apply → A34 → A26) to prove acquisition → analysis → evidence in production, then a human-selected,
scope-verified bounty repository as the first live investigation. Each is a separate approval; none is taken here.
