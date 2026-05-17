import { describe, expect, it } from "vitest";
import { buildSurplusBasisMap } from "../src/services/replacementSlotsV2Helpers";
import type { LeanPlayer } from "../src/types/brain";

describe("buildSurplusBasisMap", () => {
  const rosterKeys = new Set(["3B", "UTIL", "BN"]);

  it("uses greedy assignment surplus for draftable players", () => {
    const player: LeanPlayer = {
      mlbId: 608070,
      name: "José Ramírez",
      team: "CLE",
      position: "3B",
      positions: ["3B"],
      value: 55.58,
    } as LeanPlayer;
    const repl = { "3B": 50.68, UTIL: 56, BN: 0 };
    const marginal = new Map([
      [
        "608070",
        { slot: "3B", marginalReplacement: 50.95, surplus: 4.63 } as const,
      ],
    ]);
    const map = buildSurplusBasisMap(
      [player],
      repl,
      rosterKeys,
      undefined,
      marginal,
      new Set(["608070"]),
    );
    expect(map.get("608070")).toBeCloseTo(4.63, 2);
  });
});
