import { describe, expect, it } from "vitest";
import {
  applyInjuryAdjustment,
  injuryMultiplier,
} from "../src/services/baselineInjuryAdjustments";
import type { LeanPlayer } from "../src/types/brain";

function mk(p: Partial<LeanPlayer>): LeanPlayer {
  return {
    _id: "1",
    mlbId: 1,
    name: "X",
    team: "NYY",
    position: "OF",
    adp: 50,
    tier: 2,
    value: 20,
    ...p,
  };
}

describe("baselineInjuryAdjustments", () => {
  it("leaves healthy players unchanged", () => {
    const r = applyInjuryAdjustment({ player: mk({}), baselineValue: 25 });
    expect(r.adjustedValue).toBe(25);
    expect(r.injuryComponent).toBe(0);
  });

  it("applies stronger haircut for higher severity", () => {
    expect(injuryMultiplier(1)).toBeGreaterThan(injuryMultiplier(3));
    const lo = applyInjuryAdjustment({ player: mk({ injurySeverity: 3 }), baselineValue: 40 });
    const hi = applyInjuryAdjustment({ player: mk({ injurySeverity: 1 }), baselineValue: 40 });
    expect(lo.adjustedValue).toBeLessThan(hi.adjustedValue);
  });
});
