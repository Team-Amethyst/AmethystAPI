import { describe, expect, it } from "vitest";
import {
  catalogPlayerMarketFieldsFromLean,
  valuedPlayerMarketFieldsFromLean,
} from "../src/lib/marketAdp/wire";
import type { LeanPlayer } from "../src/types/brain";

function baseLean(partial: Partial<LeanPlayer>): LeanPlayer {
  return {
    _id: "x",
    name: "Test",
    team: "NYY",
    position: "OF",
    catalog_rank: 5,
    catalog_tier: 2,
    value: 20,
    ...partial,
  };
}

describe("market ADP wire helpers", () => {
  it("copies vendor metadata from LeanPlayer to valuation partial", () => {
    const p = baseLean({
      market_adp: 14.2,
      market_adp_source: "csv_fixture",
      market_adp_updated_at: "2026-01-01T00:00:00.000Z",
      market_adp_min: 12,
      market_adp_max: 16,
      market_pick_count: 800,
    });
    const v = valuedPlayerMarketFieldsFromLean(p);
    expect(v.market_adp).toBe(14.2);
    expect(v.market_adp_source).toBe("csv_fixture");
    expect(v.market_adp_updated_at).toBe("2026-01-01T00:00:00.000Z");
    expect(v.market_adp_min).toBe(12);
    expect(v.market_adp_max).toBe(16);
    expect(v.market_pick_count).toBe(800);
  });

  it("catalog batch helper mirrors the same fields", () => {
    const p = baseLean({
      market_adp: 3,
      market_adp_source: "nfbc_export",
    });
    const c = catalogPlayerMarketFieldsFromLean(p);
    expect(c.market_adp).toBe(3);
    expect(c.market_adp_source).toBe("nfbc_export");
  });

  it("returns empty when no market fields are set", () => {
    expect(valuedPlayerMarketFieldsFromLean(baseLean({}))).toEqual({});
  });
});
