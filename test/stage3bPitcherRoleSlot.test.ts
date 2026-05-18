import { describe, expect, it } from "vitest";
import { resolvePitcherRoleSlot } from "../src/services/stage3bPitcherAllocation";

describe("resolvePitcherRoleSlot", () => {
  it("keeps RP when not SP-eligible", () => {
    expect(
      resolvePitcherRoleSlot({
        assignedSlot: "RP",
        tokens: ["RP"],
        position: "RP",
      }),
    ).toBe("RP");
  });

  it("falls back to SP token when greedy slot is a hitter slot", () => {
    expect(
      resolvePitcherRoleSlot({
        assignedSlot: "OF",
        tokens: ["SP", "P"],
        position: "P",
      }),
    ).toBe("SP");
  });

  it("maps RP greedy assignment to SP when SP-eligible", () => {
    expect(
      resolvePitcherRoleSlot({
        assignedSlot: "RP",
        tokens: ["P", "SP"],
        position: "P",
      }),
    ).toBe("SP");
  });

  it("keeps pure closers on RP", () => {
    expect(
      resolvePitcherRoleSlot({
        assignedSlot: "RP",
        tokens: ["RP"],
        position: "RP",
      }),
    ).toBe("RP");
  });
});
