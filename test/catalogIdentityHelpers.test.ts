import { describe, expect, it } from "vitest";
import type { CatalogIdentityRow } from "../src/lib/catalogIdentityHelpers";
import {
  findShadowPairs,
  fingerprintConflict,
  hasCanonicalMlbId,
  isObjectIdStylePlayerId,
  normalizePlayerName,
  normalizeTeamAbbrev,
  preferCanonicalMlbRow,
  projectionFingerprint,
  rowUsesObjectIdPlayerId,
  valuationPlayerIdFromRow,
} from "../src/lib/catalogIdentityHelpers";

describe("catalogIdentityHelpers", () => {
  it("normalizePlayerName folds case, accents, spacing", () => {
    expect(normalizePlayerName("  José Ramírez  ")).toBe("jose ramirez");
    expect(normalizePlayerName("Trea Turner")).toBe("trea turner");
    expect(normalizePlayerName("J.T. Realmuto")).toBe("jt realmuto");
  });

  it("normalizeTeamAbbrev treats placeholders", () => {
    expect(normalizeTeamAbbrev("phi")).toBe("PHI");
    expect(normalizeTeamAbbrev("--")).toBe("--");
    expect(normalizeTeamAbbrev("fa")).toBe("--");
  });

  it("isObjectIdStylePlayerId detects 24-hex ids", () => {
    expect(isObjectIdStylePlayerId("69ac5be91f05b394067e8caa")).toBe(true);
    expect(isObjectIdStylePlayerId("607208")).toBe(false);
    expect(isObjectIdStylePlayerId("")).toBe(false);
  });

  it("valuationPlayerIdFromRow prefers mlbId", () => {
    expect(
      valuationPlayerIdFromRow({
        _id: "69ac5be91f05b394067e8caa",
        mlbId: 607208,
      })
    ).toBe("607208");
    expect(
      valuationPlayerIdFromRow({
        _id: "69ac5be91f05b394067e8caa",
        mlbId: undefined,
      })
    ).toBe("69ac5be91f05b394067e8caa");
  });

  it("findShadowPairs links ObjectId row to canonical when team is placeholder vs concrete", () => {
    const rows: CatalogIdentityRow[] = [
      {
        _id: "69ac5be91f05b394067e8c9d",
        mlbId: undefined,
        name: "William Contreras",
        team: "MIL",
        position: "C",
        adp: 50,
        tier: 1,
        value: 40,
      },
      {
        _id: "69ac5f6d45ba8d4bceba9413",
        mlbId: 661388,
        name: "William Contreras",
        team: "--",
        position: "C",
        adp: 50,
        tier: 1,
        value: 35,
      },
    ];
    const pairs = findShadowPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.shadow._id).toBe("69ac5be91f05b394067e8c9d");
    expect(pairs[0]!.canonical.mlbId).toBe(661388);
  });

  it("findShadowPairs links ObjectId-only row to canonical same name+team", () => {
    const oid = "69ac5be91f05b394067e8caa";
    const rows: CatalogIdentityRow[] = [
      {
        _id: oid,
        mlbId: undefined,
        name: "Trea Turner",
        team: "PHI",
        position: "SS",
        adp: 11,
        tier: 1,
        value: 43,
        projection: { batting: { hr: 20 } },
      },
      {
        _id: "69ac5f6d45ba8d4bceba9362",
        mlbId: 607208,
        name: "Trea Turner",
        team: "PHI",
        position: "SS",
        adp: 11,
        tier: 1,
        value: 69,
        projection: { batting: { hr: 15 } },
      },
    ];
    const pairs = findShadowPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.shadow._id).toBe(oid);
    expect(pairs[0]!.canonical.mlbId).toBe(607208);
    expect(hasCanonicalMlbId(pairs[0]!.canonical)).toBe(true);
    expect(rowUsesObjectIdPlayerId(pairs[0]!.shadow)).toBe(true);
  });

  it("preferCanonicalMlbRow chooses MLB-id row", () => {
    const a: CatalogIdentityRow = {
      _id: "aa",
      mlbId: 1,
      name: "A",
      team: "X",
      position: "C",
      adp: 5,
      tier: 1,
      value: 10,
    };
    const b: CatalogIdentityRow = {
      _id: "69ac5be91f05b394067e8caa",
      name: "A",
      team: "X",
      position: "C",
      adp: 5,
      tier: 1,
      value: 9,
    };
    const { canonical, other } = preferCanonicalMlbRow(a, b);
    expect(canonical.mlbId).toBe(1);
    expect(other._id).toBe(b._id);
  });

  it("fingerprintConflict flags large HR divergence", () => {
    const a = projectionFingerprint({ batting: { hr: 60 } });
    const b = projectionFingerprint({ batting: { hr: 10 } });
    expect(fingerprintConflict(a, b)).toBe(true);
    const c = projectionFingerprint({ batting: { hr: 60, rbi: 120 } });
    const d = projectionFingerprint({ batting: { hr: 61, rbi: 118 } });
    expect(fingerprintConflict(c, d)).toBe(false);
  });
});
