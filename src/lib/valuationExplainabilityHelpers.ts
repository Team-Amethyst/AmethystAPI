import type { ValuationResponse, ValuedPlayer } from "../types/brain";

export type InflationHeadlineBasis = "neutral_1" | "opening_index";

export function stripAlertPrefix(s: string): string {
  return s.replace(/^⚠️\s*/, "").trim();
}

export function formatHeadline(
  f: number,
  topPosition: string | null,
  basis: InflationHeadlineBasis
): string {
  const pct = Math.round((f - 1) * 100);
  const vs = basis === "opening_index" ? "auction open" : "neutral";
  if (pct >= 12) {
    return topPosition
      ? `Market is inflated (+${pct}% vs ${vs}) and ${topPosition} is the top scarcity pressure point.`
      : `Market is inflated (+${pct}% vs ${vs}), so premium tiers are likely to clear above list value.`;
  }
  if (pct <= -12) {
    return topPosition
      ? `Market is deflated (${pct}% vs ${vs}) but ${topPosition} still shows scarcity pressure.`
      : `Market is deflated (${pct}% vs ${vs}), so disciplined value bidding should hold.`;
  }
  return topPosition
    ? `Market is near ${basis === "opening_index" ? "auction-open baseline" : "neutral"} and ${topPosition} is the key position to monitor.`
    : basis === "opening_index"
      ? "Market is near the auction-open baseline and value is broadly distributed across positions."
      : "Market is near neutral and value is broadly distributed across positions.";
}

function positionTokens(pos: string): string[] {
  return pos
    .split(/[,/]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function findPositionAlert(
  alerts: Array<{ position: string }>,
  position: string | undefined
): { position: string } | undefined {
  if (!position) return undefined;
  const tokens = positionTokens(position);
  for (const tok of tokens) {
    const match = alerts.find((a) => a.position.toUpperCase() === tok);
    if (match) return match;
  }
  return undefined;
}

export function rounded(n: number): number {
  return Number(n.toFixed(2));
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function buildDriverRows(row: ValuedPlayer, response: ValuationResponse) {
  const inflationFactor = response.inflation_factor;
  const scarcityImpact = rounded(row.scarcity_adjustment ?? 0);
  const inflationImpact = rounded(row.inflation_adjustment ?? 0);
  const delta = rounded(row.adjusted_value - row.baseline_value);
  const otherImpact = rounded(delta - scarcityImpact - inflationImpact);
  const scFac = row.baseline_components?.scarcity_component ?? 0;
  const raw = response.inflation_raw;
  const bounded = response.inflation_bounded_by;
  const idxOpen = response.inflation_index_vs_opening_auction;
  let leagueReason =
    response.inflation_model === "replacement_slots_v2"
      ? `replacement_slots_v2: slot-aware surplus allocation (factor ${inflationFactor.toFixed(2)}× on marginal list $ above replacement); see response replacement_values_by_slot_or_position and fallback_reason.${
          idxOpen != null && Number.isFinite(idxOpen)
            ? ` Auction-open index ${idxOpen.toFixed(2)}× (1.0 = same allocator at replayed auction open).`
            : ""
        }`
      : `League-wide factor ${inflationFactor.toFixed(2)}× applied to list_value (baseline already includes scoring/roster scarcity).`;
  if (bounded === "cap") {
    leagueReason += ` Raw ratio was ${raw.toFixed(2)}× before the workflow cap.`;
  } else if (bounded === "floor") {
    leagueReason += ` Raw ratio was ${raw.toFixed(2)}× before the workflow floor.`;
  }
  const drivers = [
    {
      label: "League inflation",
      impact: inflationImpact,
      reason: leagueReason,
    },
    {
      label: `Scarcity context (${row.position})`,
      impact: scarcityImpact,
      reason:
        Math.abs(scFac) < 0.001
          ? "No roster scarcity multiplier on this row (see baseline_components)."
          : `Scarcity multiplier ${scFac.toFixed(3)} is embedded in list_value; scarcity_adjustment stays 0 so drivers reconcile to auction_target − list_value.`,
    },
    {
      label: "Other model effects",
      impact: otherImpact,
      reason:
        Math.abs(otherImpact) < 0.25
          ? "No residual; Steal/Reach comes from ADP vs value rank, not an extra dollar line item."
          : "Rounding residual only.",
    },
  ].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return { scarcityImpact, inflationImpact, otherImpact, drivers };
}

export function buildPlayerWhy(
  row: ValuedPlayer,
  leagueInflation: number,
  scarcityByPos: Map<string, { score: number; alert: string | null }>
): string[] {
  const why: string[] = [];
  if (row.indicator === "Steal") {
    why.push(
      "Model ranks this player higher than ADP implies the market does — possible value."
    );
  } else if (row.indicator === "Reach") {
    why.push(
      "ADP is ahead of model rank — paying full sticker price may be risky."
    );
  } else {
    why.push("ADP and model auction value are broadly aligned.");
  }

  why.push(
    `Adjusted auction $${row.adjusted_value.toFixed(1)} vs baseline $${row.baseline_value.toFixed(1)} after league inflation (${leagueInflation.toFixed(2)}×).`
  );

  const scFac = row.baseline_components?.scarcity_component ?? 0;
  if (Number.isFinite(scFac) && Math.abs(scFac) >= 0.01) {
    why.push(
      `Roster/scarcity is reflected in baseline list price (scarcity_component=${scFac.toFixed(3)} on baseline_components), before the league inflation factor.`
    );
  }

  for (const tok of positionTokens(row.position)) {
    const sc = scarcityByPos.get(tok);
    if (sc && sc.score >= 60 && sc.alert) {
      why.push(`${tok}: ${stripAlertPrefix(sc.alert)}`);
      break;
    }
  }

  if ((row.tier || 99) <= 1 && leagueInflation > 1.08) {
    why.push("Elite tier in an inflated market — expect competitive bidding.");
  }

  return why;
}
