import { describe, expect, it } from "vitest";
import { expandNameKeys, mergeMongoWithFixtureIdentities } from "../src/lib/replayMongoFixtureMerge";
import type { LeanPlayer } from "../src/types/brain";

describe("expandNameKeys", () => {
  it("includes Jr-stripped and dot-collapsed variants", () => {
    const k = expandNameKeys("Fernando Tatis Jr.");
    expect(k).toContain("fernando tatis");
  });

  it("collapses J.T. style initials", () => {
    const k = expandNameKeys("J.T. Realmuto");
    expect(k.some((x) => x.includes("jt"))).toBe(true);
  });
});

describe("mergeMongoWithFixtureIdentities", () => {
  it("re-keys by fixture id when Mongo has same mlbId", () => {
    const mongo: LeanPlayer[] = [
      {
        _id: "a",
        mlbId: 665487,
        name: "Fernando Tatis Jr.",
        team: "SD",
        position: "OF",
        adp: 3,
        tier: 1,
        value: 44,
      },
    ];
    const fixture = new Map([
      ["665487", { name: "Fernando Tatis", position: "OF", team: "SD" }],
    ]);
    const { pool, warnings } = mergeMongoWithFixtureIdentities(mongo, fixture);
    const row = pool.find((p) => p.mlbId === 665487);
    expect(row?.name).toBe("Fernando Tatis");
    expect(row?.value).toBe(44);
    expect(warnings.some((w) => w.includes("vs Mongo"))).toBe(true);
  });

  it("maps fixture typo Boegarts → Bogaerts via alias", () => {
    const mongo: LeanPlayer[] = [
      {
        _id: "a",
        mlbId: 593428,
        name: "Xander Bogaerts",
        team: "SD",
        position: "SS",
        adp: 20,
        tier: 1,
        value: 31,
      },
    ];
    const fixture = new Map([
      ["593428", { name: "Xander Boegarts", position: "SS", team: "SD" }],
    ]);
    const { pool } = mergeMongoWithFixtureIdentities(mongo, fixture);
    const row = pool.find((p) => p.mlbId === 593428);
    expect(row?.value).toBe(31);
    expect(row?.name).toBe("Xander Boegarts");
  });

  it("adds stub row with list_value_hint when Mongo missing", () => {
    const mongo: LeanPlayer[] = [
      {
        _id: "a",
        mlbId: 1,
        name: "Other",
        team: "NYY",
        position: "OF",
        adp: 99,
        tier: 3,
        value: 5,
      },
    ];
    const fixture = new Map([
      ["999888777", { name: "Nobody", position: "SP", team: "SEA", list_value_hint: 22 }],
    ]);
    const { pool } = mergeMongoWithFixtureIdentities(mongo, fixture);
    const stub = pool.find((p) => p.mlbId === 999888777);
    expect(stub?.value).toBe(22);
    expect(stub?.name).toBe("Nobody");
  });

  it("adds stub with floor 4 when no hint", () => {
    const mongo: LeanPlayer[] = [
      {
        _id: "a",
        mlbId: 1,
        name: "Other",
        team: "NYY",
        position: "OF",
        adp: 99,
        tier: 3,
        value: 5,
      },
    ];
    const fixture = new Map([
      ["999888778", { name: "Nobody2", position: "SP", team: "SEA" }],
    ]);
    const { pool } = mergeMongoWithFixtureIdentities(mongo, fixture);
    expect(pool.find((p) => p.mlbId === 999888778)?.value).toBe(4);
  });
});
