import { describe, expect, it } from "vitest";
import {
  CALIBRATION_CATS_5X5,
  CALIBRATION_CATS_SAVES_ONLY,
} from "../src/lib/calibrationDraftroomFixture";

describe("calibrationDraftroomFixture category sets", () => {
  it("CALIBRATION_CATS_SAVES_ONLY omits W and differs from standard 5x5 summary", () => {
    const std = CALIBRATION_CATS_5X5.map((c) => `${c.name}:${c.type}`).join("|");
    const sav = CALIBRATION_CATS_SAVES_ONLY.map((c) => `${c.name}:${c.type}`).join("|");
    expect(sav).not.toBe(std);
    expect(CALIBRATION_CATS_SAVES_ONLY.some((c) => c.name === "W")).toBe(false);
    expect(CALIBRATION_CATS_5X5.some((c) => c.name === "W")).toBe(true);
    expect(CALIBRATION_CATS_SAVES_ONLY.filter((c) => c.type === "batting")).toEqual(
      CALIBRATION_CATS_5X5.filter((c) => c.type === "batting")
    );
  });
});
