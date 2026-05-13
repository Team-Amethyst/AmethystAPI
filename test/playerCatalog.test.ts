import { describe, expect, it, vi } from "vitest";
import { playerTokensFromLean } from "../src/lib/fantasyRosterSlots";
import type { LeanPlayer } from "../src/types/brain";
import {
  coerceCatalogIdToString,
  normalizeCatalogPlayers,
} from "../src/lib/playerCatalog";

describe("normalizeCatalogPlayers", () => {
  it("coerces invalid value and legacy adp/tier with callbacks", () => {
    const warn = vi.fn();
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: 1,
          name: "Good",
          team: "NYY",
          position: "OF",
          value: 10,
          catalog_rank: 5,
          catalog_tier: 1,
        },
        {
          _id: "b",
          mlbId: 2,
          name: "Bad nums",
          team: "BOS",
          position: "SP",
          value: "x",
          catalog_rank: Number.NaN,
          tier: "nope",
        },
      ],
      warn
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.value).toBe(10);
    expect(rows[1]!.value).toBe(0);
    expect(rows[1]!.catalog_rank).toBe(9999);
    expect(rows[1]!.catalog_tier).toBe(0);
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("coerces numeric-string mlbId and clamps negative tier", () => {
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: "660271",
          name: "ID Parse",
          team: "LAD",
          position: "DH",
          value: 10,
          catalog_rank: 5,
          catalog_tier: -4,
        },
      ],
      () => {}
    );
    expect(rows[0]!.mlbId).toBe(660271);
    expect(rows[0]!.catalog_tier).toBe(0);
  });

  it("skips non-objects", () => {
    const rows = normalizeCatalogPlayers([null, "x", { name: "Ok", value: 1 }], () => {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ok");
  });

  it("parses positions from a comma-separated string", () => {
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: 2,
          name: "Multi",
          team: "NYY",
          position: "2B",
          positions: "SS,3B",
          value: 10,
          catalog_rank: 5,
          catalog_tier: 1,
        },
      ],
      () => {}
    );
    expect(rows[0]!.positions).toEqual(["SS", "3B"]);
  });

  it("coerces injury severity from injury_severity or injurySeverity", () => {
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: 9,
          name: "IL",
          team: "NYY",
          position: "OF",
          value: 10,
          catalog_rank: 5,
          catalog_tier: 2,
          injury_severity: 2,
        },
        {
          _id: "b",
          mlbId: 10,
          name: "Fine",
          team: "BOS",
          position: "SP",
          value: 10,
          catalog_rank: 5,
          catalog_tier: 2,
          injurySeverity: 0,
        },
      ],
      () => {}
    );
    expect(rows[0]!.injurySeverity).toBe(2);
    expect(rows[1]!.injurySeverity).toBeUndefined();
  });

  it("passes through positions[] for slot/surplus eligibility", () => {
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: "a",
          mlbId: 1,
          name: "TwoWay",
          team: "LAD",
          position: "SP",
          positions: ["DH"],
          value: 95,
          catalog_rank: 2,
          catalog_tier: 1,
        },
      ],
      () => {}
    );
    expect(rows[0]!.positions).toEqual(["DH"]);
  });

  it("coerces ObjectId-like _id to its hex string so structuredClone survives", () => {
    // Mimic the BSON ObjectId / structuredClone-stripped shape we get back
    // from `Player.find().lean()` once it has been round-tripped through the
    // in-process catalog cache.  Both shapes must resolve to the same
    // canonical hex string downstream — otherwise the baseline engine's
    // `String(p._id)` Map key collapses (every row becomes "[object Object]"
    // and the last write wins, producing uniform $10 baselines).
    const oidBytes = [0x69, 0xac, 0x5f, 0x6d, 0x45, 0xba, 0x8d, 0x4b, 0xce, 0xba, 0x93, 0x58];
    const oidHex = "69ac5f6d45ba8d4bce" + "ba9358";

    class FakeObjectId {
      buffer: Uint8Array;
      constructor(bytes: number[]) {
        this.buffer = Uint8Array.from(bytes);
      }
      toHexString(): string {
        return Array.from(this.buffer)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      toString(): string {
        return this.toHexString();
      }
    }

    const oid = new FakeObjectId(oidBytes);
    const stripped = structuredClone(oid);
    expect(String(stripped)).toBe("[object Object]"); // pre-fix bug surface
    expect(coerceCatalogIdToString(oid)).toBe(oidHex);
    expect(coerceCatalogIdToString(stripped)).toBe(oidHex);
    expect(coerceCatalogIdToString("already-a-string")).toBe("already-a-string");
    expect(coerceCatalogIdToString(undefined)).toBe("");

    // Two distinct ObjectIds must produce two distinct map keys *after*
    // a structuredClone round-trip.
    const oid2 = new FakeObjectId([
      0x66, 0x44, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33, 0x44, 0x55,
    ]);
    const rows = normalizeCatalogPlayers(
      [
        {
          _id: oid,
          mlbId: 1,
          name: "First",
          team: "NYY",
          position: "OF",
          value: 10,
          catalog_rank: 1,
          catalog_tier: 1,
        },
        {
          _id: oid2,
          mlbId: 2,
          name: "Second",
          team: "BOS",
          position: "SP",
          value: 10,
          catalog_rank: 2,
          catalog_tier: 1,
        },
      ],
      () => {}
    );
    expect(rows[0]!._id).toBe(oidHex);
    expect(rows[1]!._id).toBe("6644aabbccddee1122334455");

    const cloned0 = structuredClone(rows[0]!);
    const cloned1 = structuredClone(rows[1]!);
    expect(String(cloned0._id)).toBe(oidHex);
    expect(String(cloned1._id)).toBe("6644aabbccddee1122334455");
    expect(String(cloned0._id)).not.toBe(String(cloned1._id));
  });

  it("playerTokensFromLean uses positions for v2 slot eligibility (two-way)", () => {
    const p: LeanPlayer = {
      _id: "o",
      mlbId: 660271,
      name: "Ohtani",
      team: "LAD",
      position: "SP",
      positions: ["DH"],
      catalog_rank: 2,
      catalog_tier: 1,
      value: 95,
    };
    const t = playerTokensFromLean(p);
    expect(t).toContain("SP");
    expect(t).toContain("DH");
  });
});
