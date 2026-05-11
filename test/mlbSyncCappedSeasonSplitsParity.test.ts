import { describe, expect, it } from "vitest";
import {
  anchorSplitAggPreferCapped,
  buildYearStatIndexCappedWithOptionalFullFallback,
} from "../src/lib/mlbSyncCappedSeasonSplits";
import {
  aggregatePositiveSplits,
  buildPlayerDocFromAgg,
} from "../src/lib/mlbPlayerSyncFromSplits";
import type { MlbStatSplit } from "../src/lib/mlbPlayerSyncFromSplits";

function bat(id: number, pa: number, hr: number): MlbStatSplit {
  return {
    player: { id, fullName: `P${id}` },
    team: { id: 1, abbreviation: "NYY" },
    position: { abbreviation: "CF" },
    stat: {
      atBats: Math.max(100, Math.round(pa * 0.9)),
      plateAppearances: pa,
      homeRuns: hr,
      rbi: 80,
      runs: 80,
      stolenBases: 10,
      avg: ".260",
      obp: ".330",
      slg: ".450",
      baseOnBalls: 50,
      hits: 120,
      totalBases: 200,
    },
  };
}

describe("mlbSyncCappedSeasonSplits parity helpers", () => {
  it("buildYearStatIndexCappedWithOptionalFullFallback fills full only when not skipped", () => {
    const full = new Map<number, Record<string, string | number>>([
      [1, { plateAppearances: 50 }],
      [2, { plateAppearances: 400 }],
    ]);
    const capped = new Map<number, Record<string, string | number>>([[1, { plateAppearances: 573 }]]);
    const m = buildYearStatIndexCappedWithOptionalFullFallback({
      cappedIdx: capped,
      fullIdx: full,
      candidateMlbIds: new Set([1, 2, 3]),
      skipFullFallbackForIds: new Set([1]),
    });
    expect(m.get(1)?.plateAppearances).toBe(573);
    expect(m.get(2)?.plateAppearances).toBe(400);
    expect(m.has(3)).toBe(false);
  });

  it("anchorSplitAggPreferCapped uses capped aggregate when present (legacy sync shape)", () => {
    const high = bat(1, 573, 37);
    const low = bat(1, 434, 25);
    const cappedAgg = aggregatePositiveSplits([high], []);
    const fullAgg = aggregatePositiveSplits([high, low], []);
    expect(fullAgg.get(1)?.bat?.stat.plateAppearances).toBe(434);
    expect(cappedAgg.get(1)?.bat?.stat.plateAppearances).toBe(573);
    const merged = anchorSplitAggPreferCapped(1, cappedAgg, fullAgg);
    expect(merged.bat?.stat.plateAppearances).toBe(573);
  });

  it("buildPlayerDocFromAgg matches when roster-universe uses capped anchor + merged year maps", () => {
    const last = 2025;
    const y2 = last - 1;
    const y3 = last - 2;
    const high = bat(1, 573, 37);
    const low = bat(1, 434, 25);
    const cappedAgg = aggregatePositiveSplits([high], []);
    const fullAgg = aggregatePositiveSplits([high, low], []);
    const agg = anchorSplitAggPreferCapped(1, cappedAgg, fullAgg);

    const statHigh = high.stat as Record<string, string | number>;
    const statLow = low.stat as Record<string, string | number>;
    const yearBat = new Map<number, Map<number, Record<string, string | number>>>([
      [
        last,
        buildYearStatIndexCappedWithOptionalFullFallback({
          cappedIdx: new Map([[1, statHigh]]),
          fullIdx: new Map([[1, statLow]]),
          candidateMlbIds: new Set([1]),
          skipFullFallbackForIds: new Set([1]),
        }),
      ],
      [y2, new Map([[1, statHigh]])],
      [y3, new Map([[1, statHigh]])],
    ]);
    const yearPit = new Map<number, Map<number, Record<string, string | number>>>([
      [last, new Map()],
      [y2, new Map()],
      [y3, new Map()],
    ]);
    const teamIdToAbbr = new Map<number, string>([[1, "NYY"]]);
    const doc = buildPlayerDocFromAgg(1, agg, undefined, teamIdToAbbr, yearBat, yearPit, last);
    expect(doc).not.toBeNull();
    const pa = (doc!.projection.batting as { plateAppearances?: number }).plateAppearances;
    expect(pa).toBeGreaterThan(500);
  });
});
