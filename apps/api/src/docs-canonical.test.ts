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
