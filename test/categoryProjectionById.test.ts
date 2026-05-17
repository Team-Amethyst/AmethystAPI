import { describe, expect, it } from "vitest";
import { categoryProjectionByIdFromPlayers } from "../src/lib/categoryProjectionById";
import type { LeanPlayer } from "../types/brain";

describe("categoryProjectionByIdFromPlayers", () => {
  it("reads projection_component from valuation meta", () => {
    const p = {
      _id: "p1",
      name: "Test",
      value: 50,
      projection: {
        __valuation_meta__: { projection_component: 42.5 },
      },
    } as unknown as LeanPlayer;
    const m = categoryProjectionByIdFromPlayers([p]);
    expect(m.get("p1")).toBe(42.5);
  });
});
