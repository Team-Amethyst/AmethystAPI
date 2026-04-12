import { describe, expect, it } from "vitest";
import { ENGINE_CONTRACT_VERSION } from "../src/lib/engineContract";
import { validateValuationResponse } from "../src/lib/valuationQuality";
import type { ValuationResponse, ValuedPlayer } from "../src/types/brain";

function baseRow(over: Partial<ValuedPlayer> = {}): ValuedPlayer {
  return {
    player_id: "1",
    name: "A",
    position: "OF",
    team: "NYY",
    adp: 10,
    tier: 1,
    baseline_value: 10,
    adjusted_value: 11,
    indicator: "Fair Value",
    inflation_factor: 1.1,
    ...over,
  };
}

function baseResponse(over: Partial<ValuationResponse> = {}): ValuationResponse {
  return {
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    inflation_factor: 1.1,
    total_budget_remaining: 100,
    pool_value_remaining: 200,
    players_remaining: 5,
    valuations: [baseRow()],
    calculated_at: "1970-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("validateValuationResponse", () => {
  it("accepts a healthy response", () => {
    const q = validateValuationResponse(baseResponse());
    expect(q.ok).toBe(true);
  });

  it("rejects wrong engine_contract_version", () => {
    const q = validateValuationResponse(
      baseResponse({ engine_contract_version: "0" })
    );
    expect(q.ok).toBe(false);
  });

  it("rejects missing engine_contract_version", () => {
    const bad = { ...baseResponse() } as Record<string, unknown>;
    delete bad.engine_contract_version;
    const q = validateValuationResponse(bad as ValuationResponse);
    expect(q.ok).toBe(false);
  });

  it("rejects non-finite inflation_factor", () => {
    const q = validateValuationResponse(
      baseResponse({ inflation_factor: Number.NaN })
    );
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.issues.some((i) => i.includes("inflation_factor"))).toBe(true);
  });

  it("rejects negative total_budget_remaining", () => {
    const q = validateValuationResponse(
      baseResponse({ total_budget_remaining: -1 })
    );
    expect(q.ok).toBe(false);
  });

  it("rejects negative pool_value_remaining", () => {
    const q = validateValuationResponse(
      baseResponse({ pool_value_remaining: -0.01 })
    );
    expect(q.ok).toBe(false);
  });

  it("rejects bad players_remaining", () => {
    expect(
      validateValuationResponse(baseResponse({ players_remaining: 1.5 })).ok
    ).toBe(false);
    expect(
      validateValuationResponse(baseResponse({ players_remaining: -1 })).ok
    ).toBe(false);
  });

  it("rejects empty calculated_at", () => {
    const q = validateValuationResponse(baseResponse({ calculated_at: "" }));
    expect(q.ok).toBe(false);
  });

  it("rejects non-array valuations", () => {
    const q = validateValuationResponse(
      baseResponse({ valuations: null as unknown as ValuedPlayer[] })
    );
    expect(q.ok).toBe(false);
  });

  it("flags negative baseline_value", () => {
    const q = validateValuationResponse(
      baseResponse({ valuations: [baseRow({ baseline_value: -1 })] })
    );
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.issues.some((i) => i.includes("baseline_value"))).toBe(true);
  });

  it("flags negative adjusted_value", () => {
    const q = validateValuationResponse(
      baseResponse({ valuations: [baseRow({ adjusted_value: -5 })] })
    );
    expect(q.ok).toBe(false);
  });

  it("rejects invalid indicator", () => {
    const q = validateValuationResponse(
      baseResponse({
        valuations: [baseRow({ indicator: "Bogus" as ValuedPlayer["indicator"] })],
      })
    );
    expect(q.ok).toBe(false);
  });

  it("rejects empty player_id", () => {
    const q = validateValuationResponse(
      baseResponse({ valuations: [baseRow({ player_id: "" })] })
    );
    expect(q.ok).toBe(false);
  });

  it("accumulates multiple row issues", () => {
    const q = validateValuationResponse(
      baseResponse({
        valuations: [
          baseRow({
            player_id: "",
            baseline_value: Number.POSITIVE_INFINITY,
            indicator: "Nope" as ValuedPlayer["indicator"],
          }),
        ],
      })
    );
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.issues.length).toBeGreaterThanOrEqual(3);
  });
});
