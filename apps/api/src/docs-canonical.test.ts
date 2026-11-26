import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the canonical roadmap and decision log", () => {
  const plan = read("docs/research-intelligence-plan.md");
  it("records the four agreed roadmap capabilities", () => {
    const rows = plan.split("## 9.")[1]!.split("## 10.")[0]!;
    for (const [id, name] of [["5.4B", "Automated Security Toolchain"], ["5.5A", "Weirdness Engine"], ["-", "Adaptive Research Priority Engine"], ["5.9", "Live Engine Control Room"]]) {
      expect(rows, name).toContain(`| **${id}** | **${name}** |`);
    }
  });
  it("requires the control room to show only genuine activity", () => {
    const row = plan.split("\n").find((l) => l.includes("Live Engine Control Room") && l.includes("genuine"))!;
    expect(row).toBeTruthy();
    expect(row).toMatch(/No simulated or demo activity in production/);
    for (const thing of ["events", "running tools", "agent activity", "queues", "costs", "errors", "progress"]) expect(row, thing).toContain(thing);
  });
  it("does not claim the Weirdness Engine is defined, and does not authorise any addition", () => {
    expect(plan).toMatch(/The definition is not yet written/);
    expect(plan).toMatch(/none designed, approved for implementation or started/);
  });
  it("keeps Task 5.3 unauthorised and records the hosting and acquisition decisions with dates", () => {
    expect(plan).toMatch(/Task 5\.3 \(Discover\) is not authorised/);
    expect(plan).toMatch(/\| 2026-11-25 \| \*\*Hosting approved and executed\.\*\*/);
    expect(plan).toMatch(/\*\*PR 5\.2 Repository Acquisition approved\*\*/);
    expect(plan).toMatch(/section 10 is the current, canonical decision log/i);
  });
});

describe("the canonical roadmap keeps every phase, status and permanent boundary", () => {
  const roadmap = read("docs/ROADMAP.md");
  const backlog = read("docs/backlog.md");
  it("lists every Phase 5 stage and the two cross-phase capabilities", () => {
    for (const id of ["5.0", "5.1", "5.2", "5.3", "5.4", "5.4B", "5.5", "5.5A", "5.6", "5.7", "5.8"]) expect(roadmap, id).toMatch(new RegExp(`\\| \\*\\*${id.replace(".", "\\.")} `));
    expect(roadmap).toContain("Adaptive Research Priority Engine");
    expect(roadmap).toContain("Live Engine Control Room");
  });
  it("does not claim 5.2 or 5.0 is verified against real GitHub", () => {
    const row = roadmap.split("\n").find((l) => l.startsWith("| **5.2 Repository acquisition**"))!;
    expect(row).toMatch(/\*\*Implemented but unverified\*\*/);
    expect(row).toMatch(/No real GitHub validation has been done/);
    expect(roadmap.split("\n").find((l) => l.startsWith("| **5.0 Bounty discovery**"))!).toMatch(/Implemented but unverified/);
  });
  it("keeps the permanent decisions", () => {
    for (const phrase of ["Immunefi (highest priority)", "X is a manually supplied channel", "never fabricates retrieved content", "No invented calibrated probabilities", "No Vercel", "known-positive capability benchmark, not proof of novel discovery", "candidate, not a confirmed match", "No automatic bounty submissions", "database-backed"]) expect(roadmap, phrase).toContain(phrase);
  });
  it("preserves the Immunefi scout position honestly and keeps the integrity issue visible", () => {
    const scout = read("docs/immunefi-scout.md");
    expect(roadmap).toContain("Discovery precedes scanning");
    expect(scout).toMatch(/source files themselves are not available to me/);
    expect(scout).toMatch(/public-api\/bounties\.json/);
    expect(read("docs/opportunity-model-design.md")).toMatch(/design only\. No migration is written/);
    expect(scout).toMatch(/no automated access to immunefi\.com or its JSON file is built or run/i);
    expect(scout).toMatch(/not tamper-proof/);
    expect(roadmap).toMatch(/\| S1 \|[^\n]*not tamper-proof/);
    expect(read("docs/architecture.md")).toMatch(/Discovery runs \*\*before\*\* repository scanning/);
    expect(read("docs/research-intelligence-plan.md")).toMatch(/Discovery precedes repository scanning; the Immunefi scout is preserved/);
  });
  it("has a backlog task with every required field and recommends exactly one next task", () => {
    expect(backlog.match(/^## Recommended next implementation task\n\*\*T-\d+ /m)).toBeTruthy();
    const tasks = backlog.split("### T-").slice(1);
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    for (const t of tasks) for (const field of ["Phase", "Dependencies", "Scope", "Acceptance criteria", "Required tests", "Security considerations", "Approval required"]) expect(t.slice(0, 200) + t, field).toContain(`| ${field} |`);
  });
});

describe("APEX, the Priority Engine and multi-domain commitments are preserved without weakening anything", () => {
  const roadmap = read("docs/ROADMAP.md"); const apex = read("docs/apex.md"); const pe = read("docs/adaptive-priority-engine-design.md");
  const md = read("docs/multi-domain-research.md"); const backlog = read("docs/backlog.md"); const plan = read("docs/research-intelligence-plan.md");
  it("records APEX as a workstream under 5.5 with no renumbering, all eight capabilities and the required relationships", () => {
    expect(roadmap).toContain("`5.5-APEX`"); expect(roadmap).toMatch(/Numbering adjustment: none/);
    for (const c of ["Execution Path Explorer", "Assumption Breaker", "Protocol Interaction Explorer", "Temporal Sequence Hunter", "Novel Hypothesis Generator", "Adaptive Search Engine", "Counterexample and Validation Engine", "Durable Discovery Memory"]) expect(apex, c).toContain(c);
    for (const ph of ["5.3 Intelligence mapping", "5.4 Structural analysis", "5.4B Automated toolchain", "5.5 Specialist intelligence", "5.5A Weirdness Engine", "5.6 Independent challenge", "5.7 Dossiers", "5.8 Benchmarks and learning"]) expect(apex, ph).toContain(ph);
    for (const id of ["5.0", "5.1", "5.2", "5.3", "5.4", "5.4B", "5.5", "5.5A", "5.6", "5.7", "5.8"]) expect(roadmap, id).toMatch(new RegExp(`\\| \\*\\*${id.replace(".", "\\.")} `));
  });
  it("keeps APEX unauthorised, prior-art first, evidence-based about originality, and independently benchmarked", () => {
    expect(apex).toMatch(/not authorised for implementation, not started/); expect(roadmap).toMatch(/not authorised for implementation, not started/);
    expect(apex).toMatch(/No originality is claimed without evidence/); expect(roadmap).toMatch(/originality is not claimed without evidence/);
    for (const t of [apex, roadmap]) expect(t).toContain("independently confirmed APEX-only discoveries");
    expect(apex).toMatch(/APEX does not create or grade its own benchmark/); expect(apex).toMatch(/never judges its own output|never judge its own output|cannot be the component that validates it/);
    for (const cmp of ["existing security tools", "the current AgentSmith analyzer", "combined conventional tooling", "AgentSmith with APEX disabled", "AgentSmith with APEX enabled"]) expect(apex, cmp).toContain(cmp);
  });
  it("keeps the Priority Engine honest: no invented probabilities, version-aware coverage, no whole-project penalty, learning only from confirmed outcomes", () => {
    expect(pe).toMatch(/No invented probabilities/); expect(pe).toMatch(/never penalising a whole project/); expect(pe).toMatch(/new or changed code is never treated as already audited|changed or new code is never treated as already audited/);
    expect(pe).toMatch(/Never\*\* treat unverified or self-generated findings as confirmed/); expect(pe).toMatch(/exploration/i); expect(pe).toMatch(/Freshness is a signal|freshness alone cannot/i);
    expect(roadmap).toMatch(/no calibrated probabilities until independent evidence supports them/);
  });
  it("records multi-domain research without assuming the Solidity analyzer transfers, with smart contracts as the immediate focus", () => {
    expect(md).toMatch(/not assumed reusable for Web2/); expect(md).toMatch(/Immediate focus/);
    for (const d of ["Web application", "API", "Cloud and infrastructure", "Software supply chain", "Identity systems"]) expect(md, d).toContain(d);
    expect(md).toMatch(/Active testing|active testing/); expect(roadmap).toContain("`MD`");
  });
  it("has unique task IDs, expands T-050 and T-051 in place, and reserves the new series with complete fields", () => {
    const ids = [...backlog.matchAll(/^### (T-\d+):/gm)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(60); expect(new Set(ids).size).toBe(ids.length);
    for (const want of ["T-050", "T-051", "T-052", "T-053", "T-054", "T-055", "T-056", "T-057", "T-058", ...Array.from({ length: 13 }, (_, i) => `T-${150 + i}`), ...Array.from({ length: 10 }, (_, i) => `T-${170 + i}`)]) expect(ids, want).toContain(want);
    for (const block of backlog.split("### T-").slice(1).filter((b) => /^(05[0-8]|1[5-6]\d|17\d)/.test(b))) for (const f of ["Phase", "Dependencies", "Scope", "Acceptance criteria", "Required tests", "Security considerations", "Approval required"]) expect(block.slice(0, 2500), f).toContain(`| ${f} |`);
    expect(backlog).toMatch(/not authorised/); expect(backlog).toMatch(/ID registry/);
  });
  it("records the three commitments in the research-intelligence plan and keeps the earlier rows", () => {
    expect(plan).toMatch(/\*\*5\.5-APEX\*\* \| \*\*AgentSmith APEX/); expect(plan).toMatch(/Multi-domain security research/); expect(plan).toMatch(/Adaptive Research Priority Engine expanded/);
    expect(plan).toContain("| **-** | **Adaptive Research Priority Engine** |"); expect(plan).toMatch(/The definition is not yet written/);
  });
});

describe("this cycle's decisions are recorded without overclaiming", () => {
  const pe = read("docs/adaptive-priority-engine-design.md"); const mem = read("docs/research-memory-gaps.md"); const pa = read("docs/apex-prior-art.md");
  it("records the adopted Priority Engine policies", () => {
    expect(pe).toMatch(/20 percent of research capacity is reserved for exploration and 80 percent/);
    expect(pe).toMatch(/Only confirmed outcomes are successful discovery labels/); expect(pe).toMatch(/\*\*preregister\*\*/);
    expect(pe).toMatch(/An audit report is never proof that a repository or project is saturated/);
  });
  it("keeps the research-memory review a proposal and the confirmed rule strict", () => {
    expect(mem).toMatch(/No migration is written or applied/); expect(mem).toMatch(/`confirmed` requires at least one `supports` evaluation from an evaluator different from the generator/);
    expect(mem).toMatch(/Nothing here creates a separate memory per specialist or engine/);
  });
  it("the second prior-art pass marks its evidence and still claims no novelty", () => {
    const p2 = read("docs/apex-prior-art-pass2.md");
    expect(p2).toMatch(/No capability is rated "potentially novel"/); expect(p2).toMatch(/FULL TEXT READ/); expect(p2).toMatch(/README ONLY/);
    expect(p2).toMatch(/makes \*\*no originality claim for AgentSmith\*\*/);
  });
  it("labels the prior-art first pass as provisional and claims no novelty", () => {
    expect(pa).toMatch(/no paper was read directly/); expect(pa).toMatch(/no capability is rated "potentially novel"/);
  });
});

describe("the T-041 review, coverage and replay work stay within their approvals", () => {
  it("the opportunity-model review is for approval and writes no migration", () => {
    const r = read("docs/opportunity-model-review.md");
    expect(r).toMatch(/Nothing here is written as a migration, applied or enabled/); expect(r).toMatch(/\| D9 \|/);
    expect(read("docs/backlog.md")).toMatch(/T-041: [^\n]*\n\*\*Status 2026-11-26: NOT started/);
  });
  it("synthetic replay results are never presented as evidence", () => {
    expect(read("docs/backlog.md")).toMatch(/Only a SYNTHETIC scenario exists, so no result is evidence/);
    expect(read("docs/adaptive-priority-engine-design.md")).toMatch(/are \*\*not\*\* evidence about real discovery/);
  });
  it("records both intermittent integration failures with their causes and status", () => {
    const t = read("docs/test-reliability.md");
    expect(t).toMatch(/No test was skipped, suppressed or weakened/); expect(t).toMatch(/cause identified with high confidence, not fully proven/);
  });
});

describe("ground truth and evaluation discipline", () => {
  it("adjudications never edit frozen labels and keep human sign-off visible", () => {
    const a = read("eval/adjudications/README.md"); expect(a).toMatch(/the label is \*\*never edited\*\*/);
    const r = JSON.parse(read("eval/adjudications/heldout3-reentrancy.json")) as { records: Array<{ outcome: { corpusLabelsChanged: boolean }; adjudicator: { humanSignOff: string } }> };
    for (const x of r.records) { expect(x.outcome.corpusLabelsChanged).toBe(false); expect(x.adjudicator.humanSignOff).toMatch(/pending|signed/); }
  });
  it("re-scores of inspected corpora are labelled development evidence, and corpus 4 is sealed and unscored", () => {
    expect(read("docs/analyzer-failure-classes.md")).toMatch(/\*\*development evidence, not a held-out\s+measurement\*\*/);
    // corpus 4 was sealed unscored (its FROZEN.md, a sealed record, still says so) and then scored exactly once under A2
    expect(read("eval/heldout4/FROZEN.md")).toMatch(/NOT YET SCORED/);
    expect(JSON.parse(read("eval/candidates.json")).corpora["eval/heldout4"].scored).toBe(true);
  });
});

describe("cycle-5 design documents stay proposals", () => {
  it("T-144 design keeps the three provenance planes and writes no migration", () => {
    const d = read("docs/research-memory-design.md"); expect(d).toMatch(/No migration is written or applied/); expect(d).toMatch(/Three provenance planes that never mix/);
  });
  it("the D1-D9 brief answers every decision and writes no migration", () => {
    const d = read("docs/opportunity-model-decisions.md"); for (let i = 1; i <= 9; i++) expect(d).toMatch(new RegExp(`## D${i}\\.`)); expect(d).toMatch(/No migration is written or applied/);
  });
  it("the T-057 diagnosis does not change the frozen policy", () => {
    expect(read("docs/priority-engine-diagnosis.md")).toMatch(/Policy v1 is \*\*not changed\*\*/);
  });
});

describe("roadmap reconciliation (2026-11-26) stays evidence-based", () => {
  const rm = read("docs/ROADMAP.md");
  it("keeps the previous status table as history and adds a dated reconciled status", () => {
    expect(rm).toMatch(/### Reconciled status \(2026-11-26/); expect(rm).toMatch(/Previous verification, kept as history/);
    expect(rm).toMatch(/\*\*5\.0 Bounty discovery\*\* \| \*\*Implemented but unverified\*\*/);
  });
  it("does not overstate the foundation: multi-source discovery, architecture mapping and the review path are not done", () => {
    expect(rm).toMatch(/\| 5\.0 Multi-source discovery \| 1 \|/); expect(rm).toMatch(/\| 5\.3 Architecture and attack-surface intelligence \| 1/);
    expect(rm).toMatch(/\| 5\.1 Research-state store \| 4 \| \*\*Corrected\*\*/); expect(rm).toMatch(/two research pipelines coexist/);
  });
  it("the approval register assumes no approval", () => {
    expect(read("docs/approval-register.md")).toMatch(/NO approval is assumed or recorded here/);
  });
});

describe("T-149 design stays a design and remains the authority", () => {
  it("is marked as an approved design whose implementation stages stay individually gated", () => {
    const d = read("docs/unified-research-workflow.md");
    expect(d).toMatch(/DESIGN, APPROVED as the architectural authority \(A16, 2026-11-26\)\. Implementation stages remain individually gated/); expect(d).toMatch(/No implementation, no migration, no production change/);
    expect(d).toMatch(/Only stage 8, with an independent supporting evaluation \*\*and\*\* a human `supports` review, can produce `confirmed`/);
  });
  it("the conforming designs point to T-149", () => {
    for (const f of ["docs/discovery-intake-design.md", "docs/protocol-representation-design.md", "docs/research-memory-design.md"]) expect(read(f)).toMatch(/[Cc]onforms to T-149/);
  });
  it("the corpus-4 checklist runs only after approval and forbids inspection before scoring", () => {
    const c = read("docs/corpus4-freeze-before-score-checklist.md"); expect(c).toMatch(/Executes ONLY after owner approval A2/); expect(c).toMatch(/Nobody opens/);
  });
});

describe("approved designs stay within their approvals (A16, A17, A4, A20; A18 deferred)", () => {
  it("the T-144 draft is outside db/migrations and documented as a draft", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    expect(readdirSync(join(root, "db", "migrations")).some((f: string) => /0009|research_memory/.test(f))).toBe(false);
    expect(read("db/drafts/t144-research-memory/README.md")).toMatch(/draft only/);
  });
  it("legacy stages are not retired before behavioural equivalence, and template hypotheses stay non-validated history", () => {
    const d = read("docs/unified-research-workflow.md");
    expect(d).toMatch(/Kept running until replaced/); expect(d).toMatch(/\*\*Behavioural-equivalence tests \(gate for A18\)\.\*\*/);
    expect(d).toMatch(/\*\*non-validated\*\*/);
  });
  it("protocol model steps require a real consumer, with a stop/go review after P3", () => {
    const p = read("docs/protocol-model-p1-p3-plan.md"); expect(p).toMatch(/at least one real\s+consumer/); expect(p).toMatch(/Stop\/go review with the owner after P3/);
  });
});

describe("P1 and corpus-4 records stay honest", () => {
  it("P1 evidence stops before P2 and does not call P1 architecture intelligence", () => {
    const e = read("docs/protocol-model-p1-evidence.md"); expect(e).toMatch(/P2 is NOT started; it awaits this review/); expect(e).toMatch(/\*\*P1 is not architecture intelligence yet\.\*\*/);
  });
  it("the execution plan keeps the north-star metric unmeasured until outcomes can be recorded, and leaves D1-D9 and S2 undecided", () => {
    const x = read("docs/execution-plan.md"); expect(x).toMatch(/\*\*not measurable yet\*\*/); expect(x).toMatch(/S2, the human-review and outcome API: exact scope \(NOT approved; for decision\)/);
    for (let i = 1; i <= 9; i++) expect(x).toMatch(new RegExp(`\\| D${i} \\|`));
  });
  it("corpus-4 results claim no significant improvement", () => {
    expect(read("eval/results/README.md")).toMatch(/no\s+claim\s+of\s+significant\s+improvement\s+is\s+made/);
  });
});

describe("decision M and community directories stay within bounds", () => {
  it("records the differentiation premise as a hypothesis and keeps it inside the existing engine", () => {
    const rm = read("docs/ROADMAP.md"); expect(rm).toMatch(/### M\. Differentiated vulnerability discovery/); expect(rm).toMatch(/to investigate, not an established fact/);
    const pe = read("docs/adaptive-priority-engine-design.md"); expect(pe).toMatch(/requirements on THIS engine, not a separate one/); expect(pe).toMatch(/\*\*v1 stays frozen and unchanged\.\*\*/);
  });
  it("treats community directories as untrusted indexes with no access enabled", () => {
    const d = read("docs/discovery-intake-design.md"); expect(d).toMatch(/Status: NOT ASSESSED/); expect(d).toMatch(/No scraping, polling, protection bypass or adapter/);
    expect(read("docs/backlog.md")).toMatch(/### T-137: Assess community bounty directory/);
  });
});

describe("stale statements are corrected", () => {
  it("fly.toml no longer calls agentsmith-multihub the existing production app", () => {
    const head = read("fly.toml").split("\n").slice(0, 4).join("\n");
    expect(head).toMatch(/LEGACY \/ DO NOT DEPLOY/);
    expect(head).not.toMatch(/names the existing app/);
  });
  it("the hub config and plan say the hub is deployed", () => {
    expect(read("fly.hub.toml").split("\n")[0]).toMatch(/DEPLOYED/);
    expect(read("docs/hub-production-plan.md").split("\n")[0]).toMatch(/DEPLOYED/);
  });
  it("the retirement audit and the Hunt document carry their corrections", () => {
    expect(read("docs/hub-retirement-audit.md")).toMatch(/Update 2026-11-25[^\n]*Fly is now inspected/);
    expect(read("docs/existing-hunt-board-integration.md")).toMatch(/Correction \(2026-11-25\)[^\n]*not by GitHub Pages/);
  });
});

describe("the release plan is a plan, not a record", () => {
  const rel = read("docs/first-production-release-plan.md");
  it("records exactly what was deployed and keeps the engine idle", () => {
    expect(rel).toMatch(/RELEASE 1 DEPLOYED 2026-11-26/);
    expect(rel).toMatch(/\*\*Release 1 was deployed on 2026-11-26\*\*/);
    expect(rel).toMatch(/\*\*Idle engine:\*\*/);
  });
  it("names exact rollback target, migrations, permissions and the open blockers", () => {
    expect(rel).toContain("hub-b5bc4b548c2e");
    expect(rel).toMatch(/\| 8 \| \*\*Rollback target and procedure\*\* \|[^\n]*sha256:69978a782c724de2ef37a974aeb32cf909ac968d6de3e8fdc5e5aa07f28e02a8/);
    expect(rel).toMatch(/## 2\. Migrations\n\*\*None\.\*\*/);
    expect(rel).toMatch(/a0c96e3/);
    expect(rel).toMatch(/Real Docker build never performed/);
  });
  it("records the deployed digest, the accepted owner-role risk and the trial-machine limitation honestly", () => {
    expect(rel).toMatch(/## 10\. Release 1 deployment record/);
    expect(rel).toMatch(/sha256:c0eaf87d35e26af4bae688e9209959f263fb92d6a6d623901bb87f706048f577/);
    expect(rel).toMatch(/not tamper-proof database protection/);
    expect(rel).toMatch(/Trial machine stopping/);
    expect(rel).toMatch(/NOT TESTED by me/);
  });
  it("lists the approvals it needs", () => { expect((rel.match(/\*\*\[approval\]\*\*/g) ?? []).length).toBeGreaterThanOrEqual(5); });
});
