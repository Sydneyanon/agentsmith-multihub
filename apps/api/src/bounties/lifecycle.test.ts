import { describe, it, expect } from "vitest";
import { programmeLifecycle, type LifecycleInput } from "./lifecycle.js";

const base: LifecycleInput = { tier: "eligible", engineSuitable: true, verification: "official_confirmed", status: "active", hasReward: true, repositoriesResolved: true, run: null };

describe("programmeLifecycle: evidence-based, side states first", () => {
  it("source restriction, paused and unavailable short-circuit", () => {
    expect(programmeLifecycle({ ...base, sourceRestricted: true })).toBe("source_restricted");
    expect(programmeLifecycle({ ...base, status: "paused" })).toBe("paused");
    expect(programmeLifecycle({ ...base, status: "closed" })).toBe("unavailable");
  });
  it("classifier side states map through", () => {
    expect(programmeLifecycle({ ...base, tier: "ineligible" })).toBe("ineligible");
    expect(programmeLifecycle({ ...base, tier: "out_of_engine_scope" })).toBe("out_of_engine_scope");
    expect(programmeLifecycle({ ...base, tier: "needs_verification", verification: "community_reported" })).toBe("needs_verification");
  });

  it("climbs the ladder exactly as far as the facts allow", () => {
    expect(programmeLifecycle({ ...base })).toBe("eligible_for_research");
    // official but no repo resolved yet
    expect(programmeLifecycle({ ...base, repositoriesResolved: false })).toBe("officially_verified");
    // not officially confirmed, and not a needs_verification candidate -> discovered
    expect(programmeLifecycle({ ...base, tier: "eligible", verification: "unverified" })).toBe("discovered");
  });

  it("overlays run state once a run is linked", () => {
    expect(programmeLifecycle({ ...base, run: { status: "queued" } })).toBe("queued_for_scan");
    expect(programmeLifecycle({ ...base, run: { status: "awaiting_approval" } })).toBe("queued_for_scan");
    expect(programmeLifecycle({ ...base, run: { status: "running" } })).toBe("scanning");
    expect(programmeLifecycle({ ...base, run: { status: "succeeded" } })).toBe("scanned");
    expect(programmeLifecycle({ ...base, run: { status: "succeeded", findingUnderReview: true } })).toBe("finding_under_review");
    expect(programmeLifecycle({ ...base, run: { status: "succeeded", completed: true } })).toBe("completed");
  });

  it("a failed run falls back to the pre-run ladder so it can be re-dispatched", () => {
    expect(programmeLifecycle({ ...base, run: { status: "failed" } })).toBe("eligible_for_research");
  });
});
