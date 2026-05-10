import { describe, expect, it } from "vitest";
import {
  categoryRawValue,
  getProjectionSection,
} from "../src/services/baselineProjectionStats";
import { scoringAwareBaselinePlayers } from "../src/services/baselineValueEngine";
import type { LeanPlayer } from "../src/types/brain";

function mkPitcher(
  id: string,
  mlbId: number,
  pitching: Record<string, string | number>
): LeanPlayer {
  return {
    _id: id,
    mlbId,
    name: `P${mlbId}`,
    team: "NYM",
    position: "SP",
    catalog_rank: 100,
    catalog_tier: 2,
    value: 25,
    projection: { pitching },
  };
}

/** Standard 5×5 pitching categories used for mixed-league pitcher baselines. */
const PITCH_ROTO_5 = [
  { name: "W", type: "pitching" as const },
  { name: "SV", type: "pitching" as const },
  { name: "ERA", type: "pitching" as const },
  { name: "WHIP", type: "pitching" as const },
  { name: "K", type: "pitching" as const },
];

const rosterSpRp = [
  { position: "SP", count: 5 },
  { position: "RP", count: 2 },
];

describe("pitcher roto ERA/WHIP rate raw (not × IP)", () => {
  it("categoryRawValue uses ERA and WHIP rates only — same rate ignores IP spread", () => {
    const hi = getProjectionSection(
      mkPitcher("a", 1, {
        era: "2.50",
        whip: "1.05",
        innings: "190",
        strikeouts: 200,
        wins: 14,
        saves: 0,
      }),
      "pitching"
    );
    const lo = getProjectionSection(
      mkPitcher("b", 2, {
        era: "2.50",
        whip: "1.05",
        innings: "55",
        strikeouts: 70,
        wins: 4,
        saves: 0,
      }),
      "pitching"
    );
    expect(categoryRawValue(hi, "ERA")).toBeCloseTo(2.5, 5);
    expect(categoryRawValue(lo, "ERA")).toBeCloseTo(2.5, 5);
    expect(categoryRawValue(hi, "WHIP")).toBeCloseTo(1.05, 5);
    expect(categoryRawValue(lo, "WHIP")).toBeCloseTo(1.05, 5);
  });

  it("lower ERA/WHIP rates yield higher baseline than worse rates at same IP/K/SV/W", () => {
    const good = mkPitcher("g", 10, {
      innings: "175",
      era: "2.80",
      whip: "1.00",
      strikeouts: 190,
      wins: 13,
      saves: 0,
    });
    const bad = mkPitcher("b", 11, {
      innings: "175",
      era: "4.80",
      whip: "1.45",
      strikeouts: 190,
      wins: 13,
      saves: 0,
    });
    const filler = mkPitcher("f", 12, {
      innings: "150",
      era: "4.00",
      whip: "1.30",
      strikeouts: 150,
      wins: 10,
      saves: 0,
    });
    const out = scoringAwareBaselinePlayers(
      [good, bad, filler],
      "5x5",
      PITCH_ROTO_5,
      rosterSpRp
    );
    const vg = out.find((p) => p._id === "g")!.value;
    const vb = out.find((p) => p._id === "b")!.value;
    expect(vg).toBeGreaterThan(vb);
  });

  it("elite high-IP starter beats scrub starter — not pegged to intrinsic floor by ERA×IP artifact", () => {
    const ace = mkPitcher("ace", 694900, {
      innings: "167",
      era: "2.00",
      whip: "0.95",
      strikeouts: 199,
      wins: 11,
      saves: 0,
    });
    const scrub = mkPitcher("scr", 694901, {
      innings: "160",
      era: "5.20",
      whip: "1.50",
      strikeouts: 110,
      wins: 7,
      saves: 0,
    });
    const pool: LeanPlayer[] = [ace, scrub];
    for (let i = 0; i < 18; i++) {
      pool.push(
        mkPitcher(`x${i}`, 800000 + i, {
          innings: String(60 + i * 5),
          era: String(3.4 + i * 0.08),
          whip: String(1.15 + i * 0.02),
          strikeouts: 70 + i * 6,
          wins: i % 4,
          saves: i % 3 === 0 ? 15 : i % 5,
        })
      );
    }
    const out = scoringAwareBaselinePlayers(pool, "5x5", PITCH_ROTO_5, rosterSpRp);
    const aceRow = out.find((p) => p._id === "ace")!;
    const scrubRow = out.find((p) => p._id === "scr")!;
    expect(aceRow.value).toBeGreaterThan(scrubRow.value);
    const meta = aceRow.projection?.__valuation_meta__ as
      | { projection_component?: number }
      | undefined;
    expect(meta?.projection_component ?? 0).toBeGreaterThan(15);
  });

  it("high-IP elite starter does not lose to identical-rate low-IP arm on ERA/WHIP z inputs alone", () => {
    const sameRateHiIp = mkPitcher("hi", 20, {
      innings: "190",
      era: "3.40",
      whip: "1.18",
      strikeouts: 210,
      wins: 14,
      saves: 0,
    });
    const sameRateLoIp = mkPitcher("lo", 21, {
      innings: "62",
      era: "3.40",
      whip: "1.18",
      strikeouts: 68,
      wins: 4,
      saves: 0,
    });
    const filler = mkPitcher("mid", 22, {
      innings: "150",
      era: "4.10",
      whip: "1.28",
      strikeouts: 160,
      wins: 10,
      saves: 5,
    });
    const out = scoringAwareBaselinePlayers(
      [sameRateHiIp, sameRateLoIp, filler],
      "5x5",
      PITCH_ROTO_5,
      rosterSpRp
    );
    const hiV = out.find((p) => p._id === "hi")!.value;
    const loV = out.find((p) => p._id === "lo")!.value;
    /** Same ERA/WHIP rates; starter has more K/W — must not trail solely because IP was larger under legacy ERA×IP raw (may tie after rounding). */
    expect(hiV).toBeGreaterThanOrEqual(loV);
  });
});
