import { analyzeScarcity } from "../services/scarcityEngine";
import type {
  LeanPlayer,
  NormalizedValuationInput,
  ValuationResponse,
  ValuedPlayer,
} from "../types/brain";

function stripAlertPrefix(s: string): string {
  return s.replace(/^⚠️\s*/, "").trim();
}

function formatInflationNote(f: number): string {
  const pct = Math.round((f - 1) * 100);
  if (pct > 1) {
    return `Auction dollars are stretched vs remaining pool value (inflation ≈ +${pct}% vs a neutral 1.00 market).`;
  }
  if (pct < -1) {
    return `More projected talent value remains than unspent dollars (deflation ≈ ${pct}% vs neutral).`;
  }
  return `Remaining dollars and pool value are roughly in balance (inflation factor ${f.toFixed(2)}).`;
}

function positionTokens(pos: string): string[] {
  return pos
    .split(/[,/]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function buildPlayerWhy(
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

  if (
    row.scarcity_adjustment != null &&
    Number.isFinite(row.scarcity_adjustment) &&
    Math.abs(row.scarcity_adjustment) >= 0.5
  ) {
    why.push(
      `Scarcity / roster-fit layer shifted baseline by about $${row.scarcity_adjustment.toFixed(1)} before inflation.`
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

/**
 * Adds human-readable **additive** fields for trust / UI (`market_notes`, per-row `why`).
 * Call only after output validation succeeds so pricing semantics stay fail-closed.
 */
export function attachValuationExplainability(
  response: ValuationResponse,
  input: NormalizedValuationInput,
  allPlayers: LeanPlayer[]
): ValuationResponse {
  const scarcity = analyzeScarcity(
    allPlayers,
    input.drafted_players,
    input.num_teams,
    input.scoring_categories,
    input.league_scope
  );

  const scarcityByPos = new Map(
    scarcity.positions.map((p) => [
      p.position.toUpperCase(),
      { score: p.scarcity_score, alert: p.alert },
    ])
  );

  const market_notes: string[] = [];
  market_notes.push(formatInflationNote(response.inflation_factor));

  const sortedAlerts = [...scarcity.positions]
    .filter((p) => p.alert)
    .sort((a, b) => b.scarcity_score - a.scarcity_score)
    .slice(0, 3);
  for (const p of sortedAlerts) {
    if (p.alert) {
      market_notes.push(`${p.position}: ${stripAlertPrefix(p.alert)}`);
    }
  }

  for (const w of scarcity.monopoly_warnings.slice(0, 2)) {
    market_notes.push(stripAlertPrefix(w.message));
  }

  const valuations = response.valuations.map((row) => ({
    ...row,
    why: buildPlayerWhy(row, response.inflation_factor, scarcityByPos),
  }));

  return {
    ...response,
    market_notes,
    valuations,
  };
}
