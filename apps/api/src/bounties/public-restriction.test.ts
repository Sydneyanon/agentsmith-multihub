import { describe, it, expect } from "vitest";
import { publicFieldView, RESTRICTED_PUBLIC_SOURCES } from "./queries.js";

describe("public display restriction for HackenProof content", () => {
  it("hackenproof is restricted from public republication", () => {
    expect(RESTRICTED_PUBLIC_SOURCES.has("hackenproof")).toBe(true);
    expect(RESTRICTED_PUBLIC_SOURCES.has("community-board")).toBe(false);
    expect(RESTRICTED_PUBLIC_SOURCES.has("sherlock")).toBe(false);
  });

  it("passes through a field from a non-restricted source unchanged", () => {
    const f = { value: 50000, source: "community-board", conflicts: [] };
    expect(publicFieldView(f)).toEqual(f);
  });

  it("falls back to a non-restricted conflicting value when hackenproof is the basis", () => {
    const f = { value: 100000, source: "hackenproof", conflicts: [{ value: 50000, source: "community-board" }] };
    const view = publicFieldView(f);
    expect(view?.value).toBe(50000);
    expect(view?.source).toBe("community-board");
  });

  it("hides the value when hackenproof is the only source", () => {
    const f = { value: 100000, source: "hackenproof", conflicts: [] };
    const view = publicFieldView(f);
    expect(view?.value).toBeNull();
    expect(view?.source).toBe("");
  });

  it("tolerates undefined", () => {
    expect(publicFieldView(undefined)).toBeUndefined();
  });
});
