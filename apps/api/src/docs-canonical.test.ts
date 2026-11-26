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
  it("has a backlog task with every required field and recommends exactly one next task", () => {
    expect(backlog.match(/^## Recommended next implementation task\n\*\*T-\d+ /m)).toBeTruthy();
    const tasks = backlog.split("### T-").slice(1);
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    for (const t of tasks) for (const field of ["Phase", "Dependencies", "Scope", "Acceptance criteria", "Required tests", "Security considerations", "Approval required"]) expect(t.slice(0, 200) + t, field).toContain(`| ${field} |`);
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
