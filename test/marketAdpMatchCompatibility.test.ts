import { describe, expect, it } from "vitest";
import {
  canonicalMlbTeamAbbrevForMatch,
  normalizePlayerName,
} from "../src/lib/catalogIdentityHelpers";
import {
  catalogEligiblePositionsCompatible,
  dryRunMatchMarketAdp,
  positionCompatible,
} from "../src/lib/marketAdp/matchDryRun";
import type { LeanPlayer } from "../src/types/core";
import type { MarketAdpVendorRow } from "../src/lib/marketAdp/types";

function lean(p: Partial<LeanPlayer> & Pick<LeanPlayer, "name" | "team" | "position">): LeanPlayer {
  return {
    _id: p.mlbId ?? "x",
    mlbId: p.mlbId,
    catalogKind: "mlb",
    name: p.name,
    team: p.team,
    position: p.position,
    positions: p.positions,
    catalog_rank: p.catalog_rank ?? 1,
    catalog_tier: p.catalog_tier ?? 1,
    value: p.value ?? 1,
  };
}

describe("market ADP position compatibility", () => {
  it("vendor OF matches catalog LF / CF / RF / OF", () => {
    expect(positionCompatible("RF", "OF")).toBe(true);
    expect(positionCompatible("LF", "OF")).toBe(true);
    expect(positionCompatible("OF", "RF")).toBe(true);
    expect(positionCompatible("1B", "OF")).toBe(false);
  });

  it("catalog positions[] participates in eligibility", () => {
    const p = lean({
      mlbId: 592450,
      name: "Aaron Judge",
      team: "NYY",
      position: "RF",
      positions: ["OF", "DH"],
    });
    expect(catalogEligiblePositionsCompatible(p, "OF")).toBe(true);
  });

  it("UT vs DH remains compatible", () => {
    expect(positionCompatible("DH", "UT, P")).toBe(true);
  });

  it("treats DH vs OF as compatible (fantasy slot vs NFBC OF listing)", () => {
    expect(positionCompatible("DH", "OF")).toBe(true);
    expect(positionCompatible("OF", "DH")).toBe(true);
  });

  it("treats infield eligibility mismatches as compatible (1B vs 2B, etc.)", () => {
    expect(positionCompatible("1B", "2B")).toBe(true);
    expect(positionCompatible("DH", "2B")).toBe(true);
    expect(positionCompatible("2B", "DH")).toBe(true);
  });
});

describe("market ADP team canonicalization", () => {
  it("maps fantasy / Stats-API alias pairs to one bucket", () => {
    expect(canonicalMlbTeamAbbrevForMatch("KCR")).toBe("KC");
    expect(canonicalMlbTeamAbbrevForMatch("KC")).toBe("KC");
    expect(canonicalMlbTeamAbbrevForMatch("TBR")).toBe("TB");
    expect(canonicalMlbTeamAbbrevForMatch("CHW")).toBe("CHW");
    expect(canonicalMlbTeamAbbrevForMatch("CWS")).toBe("CHW");
    expect(canonicalMlbTeamAbbrevForMatch("SDP")).toBe("SD");
    expect(canonicalMlbTeamAbbrevForMatch("SFG")).toBe("SF");
    expect(canonicalMlbTeamAbbrevForMatch("WSN")).toBe("WSH");
    expect(canonicalMlbTeamAbbrevForMatch("ATH")).toBe("OAK");
  });
});

describe("market ADP name normalization", () => {
  it("folds Acuña / Acuna and Rodríguez / Rodriguez", () => {
    expect(normalizePlayerName("Ronald Acuña Jr.")).toBe(normalizePlayerName("Ronald Acuna Jr."));
    expect(normalizePlayerName("Julio Rodríguez")).toBe(normalizePlayerName("Julio Rodriguez"));
  });

  it("strips trailing II / III / IV", () => {
    expect(normalizePlayerName("Michael Harris II")).toBe("michael harris");
    expect(normalizePlayerName("Player Name III")).toBe("player name");
  });

  it("handles Fernando Tatis Jr. suffix variants", () => {
    expect(normalizePlayerName("Fernando Tatis Jr.")).toBe(
      normalizePlayerName("Fernando Tatis Jr")
    );
  });
});

describe("dryRunMatchMarketAdp unique name + team mismatch", () => {
  it("matches Kyle Tucker when NFBC team differs from catalog (single row each)", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 663656,
        name: "Kyle Tucker",
        team: "HOU",
        position: "OF",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 40,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Kyle Tucker",
        team: "LAD",
        position: "OF",
        adp: 14.56,
        mlb_id: null,
      },
    ];
    const { matches, proposed_updates } = dryRunMatchMarketAdp(
      catalog,
      vendor,
      "NFBC",
      "2026-01-01T00:00:00.000Z"
    );
    expect(matches[0]?.kind).toBe("matched");
    if (matches[0]?.kind === "matched") {
      expect(matches[0].match_confidence).toBe("exact_name_position_team_mismatch_unique");
    }
    expect(proposed_updates[0]?.match_confidence).toBe("exact_name_position_team_mismatch_unique");
  });

  it("matches Pete Alonso when NFBC team differs from catalog (single row each)", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 624413,
        name: "Pete Alonso",
        team: "NYM",
        position: "1B",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 30,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Pete Alonso",
        team: "BAL",
        position: "1B",
        adp: 25.93,
        mlb_id: null,
      },
    ];
    const { matches, proposed_updates } = dryRunMatchMarketAdp(
      catalog,
      vendor,
      "NFBC",
      "2026-01-01T00:00:00.000Z"
    );
    expect(matches[0]?.kind).toBe("matched");
    expect(proposed_updates[0]?.match_confidence).toBe("exact_name_position_team_mismatch_unique");
  });

  it("matches Juan Soto NYM OF vs catalog RF/LF unique name team mismatch", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 665742,
        name: "Juan Soto",
        team: "NYY",
        position: "RF",
        positions: ["LF"],
        catalog_rank: 1,
        catalog_tier: 1,
        value: 50,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Juan Soto",
        team: "NYM",
        position: "OF",
        adp: 4.31,
        mlb_id: null,
      },
    ];
    const { matches } = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(matches[0]?.kind).toBe("matched");
    if (matches[0]?.kind === "matched") {
      expect(matches[0].match_confidence).toBe("exact_name_position_team_mismatch_unique");
    }
  });

  it("matches George Springer when catalog primary is DH and NFBC lists OF (same team)", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 543807,
        name: "George Springer",
        team: "TOR",
        position: "DH",
        catalog_rank: 5,
        catalog_tier: 1,
        value: 20,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "George Springer",
        team: "TOR",
        position: "OF",
        adp: 94.75,
        mlb_id: null,
      },
    ];
    const { matches } = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(matches[0]?.kind).toBe("matched");
    if (matches[0]?.kind === "matched") {
      expect(matches[0].match_confidence).toBe("exact_name_team_position");
    }
  });

  it("matches Jorge Polanco when teams differ (unique row each) and catalog DH/1B vs NFBC 2B", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 593871,
        name: "Jorge Polanco",
        team: "SEA",
        position: "DH",
        positions: ["1B"],
        catalog_rank: 10,
        catalog_tier: 1,
        value: 15,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Jorge Polanco",
        team: "NYM",
        position: "2B",
        adp: 210.12,
        mlb_id: null,
      },
    ];
    const { matches } = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(matches[0]?.kind).toBe("matched");
    if (matches[0]?.kind === "matched") {
      expect(matches[0].match_confidence).toBe("exact_name_position_team_mismatch_unique");
    }
  });

  it("matches Ronald Acuña catalog row from ASCII NFBC name", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 660670,
        name: "Ronald Acuña Jr.",
        team: "ATL",
        position: "RF",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 50,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Ronald Acuna Jr.",
        team: "ATL",
        position: "OF",
        adp: 6.73,
        mlb_id: null,
      },
    ];
    const { matches } = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(matches[0]?.kind).toBe("matched");
  });

  it("matches Julio Rodríguez from ASCII NFBC name", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 677594,
        name: "Julio Rodríguez",
        team: "SEA",
        position: "CF",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 40,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Julio Rodriguez",
        team: "SEA",
        position: "OF",
        adp: 9.47,
        mlb_id: null,
      },
    ];
    const { matches } = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(matches[0]?.kind).toBe("matched");
  });

  it("matches Fernando Tatis Jr. suffix variants", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 665487,
        name: "Fernando Tatis Jr.",
        team: "SD",
        position: "SS",
        positions: ["OF"],
        catalog_rank: 1,
        catalog_tier: 1,
        value: 40,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Fernando Tatis Jr",
        team: "SD",
        position: "OF",
        adp: 14.1,
        mlb_id: null,
      },
    ];
    const { matches } = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(matches[0]?.kind).toBe("matched");
  });

  it("stays ambiguous when two catalog rows share name+team+position (same mlbId dup)", () => {
    const catalog: LeanPlayer[] = [
      {
        _id: "a",
        mlbId: 111,
        name: "Dup Player",
        team: "NYY",
        position: "OF",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 10,
      },
      {
        _id: "b",
        mlbId: 222,
        name: "Dup Player",
        team: "NYY",
        position: "OF",
        catalog_rank: 2,
        catalog_tier: 1,
        value: 9,
      },
    ];
    const vendor: MarketAdpVendorRow[] = [
      { name: "Dup Player", team: "NYY", position: "OF", adp: 5, mlb_id: null },
    ];
    const { matches, proposed_updates } = dryRunMatchMarketAdp(
      catalog,
      vendor,
      "NFBC",
      "2026-01-01T00:00:00.000Z"
    );
    expect(matches[0]?.kind).toBe("ambiguous");
    expect(proposed_updates).toHaveLength(0);
  });
});

describe("dryRunMatchMarketAdp integration (Judge OF vs catalog RF)", () => {
  it("matches Aaron Judge when catalog primary is RF and vendor lists OF", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 592450,
        name: "Aaron Judge",
        team: "NYY",
        position: "RF",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 50,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Aaron Judge",
        team: "NYY",
        position: "OF",
        adp: 1.93,
        adp_min: 1,
        adp_max: 5,
        sample_size: 1000,
        mlb_id: null,
      },
    ];
    const { matches, proposed_updates } = dryRunMatchMarketAdp(
      catalog,
      vendor,
      "NFBC",
      "2026-01-01T00:00:00.000Z"
    );
    expect(matches[0]?.kind).toBe("matched");
    if (matches[0]?.kind === "matched") {
      expect(matches[0].match_confidence).toBe("exact_name_team_position");
    }
    expect(proposed_updates).toHaveLength(1);
    expect(proposed_updates[0]?.player_id).toBe("592450");
  });

  it("matches when vendor uses KCR-style team and catalog uses KC", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 123,
        name: "Test Player",
        team: "KC",
        position: "SP",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 10,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Test Player",
        team: "KCR",
        position: "P",
        adp: 50,
        mlb_id: null,
      },
    ];
    const { matches } = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(matches[0]?.kind).toBe("matched");
  });
});

describe("dryRunMatchMarketAdp MLB id identity guards", () => {
  it("does not loose-match when vendor mlb_id disagrees with catalog mlbId", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 1,
        name: "Same Name",
        team: "NYY",
        position: "OF",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 1,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      {
        name: "Same Name",
        team: "NYY",
        position: "OF",
        adp: 10,
        mlb_id: 999,
      },
    ];
    const r = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(r.matches[0]?.kind).toBe("unmatched_vendor");
    expect(r.catalog_unmatched_report).toHaveLength(1);
  });

  it("does not unique team-mismatch match when vendor mlb_id disagrees with catalog mlbId", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 1,
        name: "Unique Row",
        team: "LAD",
        position: "OF",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 1,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      { name: "Unique Row", team: "NYY", position: "OF", adp: 10, mlb_id: 999 },
    ];
    const r = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(r.matches[0]?.kind).toBe("unmatched_vendor");
  });

  it("classifies name_mismatch_only when vendor MLB id exists in catalog but normalized label differs and catalog already matched", () => {
    const catalog: LeanPlayer[] = [
      lean({
        mlbId: 50,
        name: "Primary Card",
        team: "ATL",
        position: "OF",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 1,
      }),
    ];
    const vendor: MarketAdpVendorRow[] = [
      { name: "Primary Card", team: "ATL", position: "OF", adp: 5, mlb_id: 50 },
      {
        name: "Alt Display Label Only NFBC",
        team: "ATL",
        position: "OF",
        adp: 6,
        mlb_id: 50,
      },
    ];
    const r = dryRunMatchMarketAdp(catalog, vendor, "NFBC", "2026-01-01T00:00:00.000Z");
    expect(r.matches.filter((m) => m.kind === "matched")).toHaveLength(1);
    const row = r.unmatched_vendor_top_by_adp.find((x) => x.nfbc_adp === 6);
    expect(row?.classification).toBe("name_mismatch_only");
  });
});
