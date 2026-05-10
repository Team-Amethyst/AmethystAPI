import { describe, expect, it } from "vitest";
import type { CatalogIdentityRow, ShadowPair } from "../src/lib/catalogIdentityHelpers";
import {
  canonicalCandidatesForShadowOid,
  classifyShadowPair,
  countSameNameDistinctMlbIdGroups,
  findDuplicateMlbIdGroups,
  findShadowPairs,
  fingerprintConflict,
  groupKeyName,
  hasCanonicalMlbId,
  isObjectIdStylePlayerId,
  normalizePlayerName,
  normalizeTeamAbbrev,
  positionsRolesCompatible,
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

  it("same normalized name + different mlbIds => not shadow pairs (distinct people)", () => {
    const rows: CatalogIdentityRow[] = [
      {
        _id: "aa",
        mlbId: 100001,
        name: "Chris Young",
        team: "SEA",
        position: "SP",
        adp: 400,
        tier: 5,
        value: 1,
      },
      {
        _id: "bb",
        mlbId: 200002,
        name: "Chris Young",
        team: "SDP",
        position: "SP",
        adp: 401,
        tier: 5,
        value: 1,
      },
    ];
    expect(findShadowPairs(rows)).toHaveLength(0);
    expect(countSameNameDistinctMlbIdGroups(rows)).toBe(1);
  });

  it("OID shadow + one canonical mlbId + compatible team/position => shadow candidate", () => {
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
    expect(findShadowPairs(rows)).toHaveLength(1);
  });

  it("OID + canonical with materially different projections => CONFLICT_REVIEW classification", () => {
    const pair: ShadowPair = {
      key: "t",
      canonical: {
        _id: "c",
        mlbId: 1,
        name: "Test Player",
        team: "PHI",
        position: "SS",
        adp: 10,
        tier: 1,
        value: 40,
        projection: { batting: { hr: 30, rbi: 90, runs: 80, sb: 10 } },
      },
      shadow: {
        _id: "69ac5be91f05b394067e8caa",
        name: "Test Player",
        team: "PHI",
        position: "SS",
        adp: 10,
        tier: 1,
        value: 35,
        projection: { batting: { hr: 10, rbi: 40, runs: 50, sb: 2 } },
      },
    };
    expect(classifyShadowPair(pair)).toBe("CONFLICT_REVIEW");
  });

  it("P vs RP pitcher family => MANUAL_REVIEW_ROLE_MISMATCH even when saves align", () => {
    const pair: ShadowPair = {
      key: "clase",
      canonical: {
        _id: "canon",
        mlbId: 661403,
        name: "Emmanuel Clase",
        team: "--",
        position: "P",
        adp: 100,
        tier: 2,
        value: 20,
        projection: { pitching: { saves: 24 } },
      },
      shadow: {
        _id: "69ac5be91f05b394067e8cc2",
        name: "Emmanuel Clase",
        team: "CLE",
        position: "RP",
        adp: 28,
        tier: 1,
        value: 30,
        projection: { pitching: { saves: 24 } },
      },
    };
    expect(positionsRolesCompatible("P", "RP")).toBe(true);
    expect(classifyShadowPair(pair)).toBe("MANUAL_REVIEW_ROLE_MISMATCH");
  });

  it("duplicate mlbId on two Mongo docs => findDuplicateMlbIdGroups", () => {
    const rows: CatalogIdentityRow[] = [
      { _id: "a", mlbId: 999, name: "Dup", team: "X", position: "C", adp: 1, tier: 1, value: 1 },
      { _id: "b", mlbId: 999, name: "Dup", team: "X", position: "C", adp: 1, tier: 1, value: 1 },
    ];
    expect(findDuplicateMlbIdGroups(rows).get(999)?.length).toBe(2);
  });

  it("ambiguous: two -- canonicals with different mlbIds for OID shadow => no shadow pair", () => {
    const rows: CatalogIdentityRow[] = [
      {
        _id: "oid1",
        mlbId: undefined,
        name: "Alex Case",
        team: "--",
        position: "SS",
        adp: 50,
        tier: 3,
        value: 10,
      },
      {
        _id: "c1",
        mlbId: 111111,
        name: "Alex Case",
        team: "--",
        position: "SS",
        adp: 50,
        tier: 3,
        value: 12,
      },
      {
        _id: "c2",
        mlbId: 222222,
        name: "Alex Case",
        team: "--",
        position: "SS",
        adp: 55,
        tier: 3,
        value: 11,
      },
    ];
    expect(findShadowPairs(rows)).toHaveLength(0);
    const withId = rows.filter(hasCanonicalMlbId);
    const oid = rows.find((r) => r._id === "oid1")!;
    expect(canonicalCandidatesForShadowOid(oid, withId)).toHaveLength(0);
  });

  it("SS vs 2B same name is not role-compatible for shadow pairing", () => {
    const rows: CatalogIdentityRow[] = [
      {
        _id: "oidx",
        mlbId: undefined,
        name: "Sam Lee",
        team: "NYY",
        position: "SS",
        adp: 10,
        tier: 1,
        value: 5,
      },
      {
        _id: "cany",
        mlbId: 500,
        name: "Sam Lee",
        team: "NYY",
        position: "2B",
        adp: 10,
        tier: 1,
        value: 20,
      },
    ];
    expect(positionsRolesCompatible("SS", "2B")).toBe(false);
    expect(findShadowPairs(rows)).toHaveLength(0);
  });

  it("groupKeyName counts same-name rows for SAME_NAME_DISTINCT_MLB_IDS helper", () => {
    const rows: CatalogIdentityRow[] = [
      { _id: "a", mlbId: 1, name: "Pat Smith", team: "A", position: "OF", adp: 1, tier: 1, value: 1 },
      { _id: "b", mlbId: 2, name: "Pat Smith", team: "B", position: "OF", adp: 1, tier: 1, value: 1 },
    ];
    expect([...groupKeyName(rows).entries()].filter(([, a]) => a.length > 1)).toHaveLength(1);
  });
});
