import { describe, expect, it } from "vitest";
import {
  formatEtagHeader,
  ifNoneMatchIsCurrent,
  stableSignalsPayloadFingerprint,
} from "../src/lib/signalsHttp";
import type { NewsSignal } from "../src/types/brain";

describe("signalsHttp", () => {
  it("stableSignalsPayloadFingerprint ignores fetched_at", () => {
    const s: NewsSignal[] = [
      {
        player_name: "A",
        signal_type: "injury",
        severity: "high",
        description: "x",
        effective_date: "2026-01-01",
        source: "MLB",
      },
    ];
    const a = stableSignalsPayloadFingerprint(s, 1);
    const b = stableSignalsPayloadFingerprint(s, 1);
    expect(a).toBe(b);
    expect(formatEtagHeader(a)).toBe(`"${a}"`);
  });

  it("ifNoneMatchIsCurrent accepts quoted and bare validators", () => {
    const fp = "deadbeef";
    expect(ifNoneMatchIsCurrent(`"${fp}"`, fp)).toBe(true);
    expect(ifNoneMatchIsCurrent(fp, fp)).toBe(true);
    expect(ifNoneMatchIsCurrent(`W/"${fp}"`, fp)).toBe(true);
    expect(ifNoneMatchIsCurrent('"other"', fp)).toBe(false);
    expect(ifNoneMatchIsCurrent(undefined, fp)).toBe(false);
  });
});
