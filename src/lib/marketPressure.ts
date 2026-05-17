import {
  buildRosteredPlayersForSlotEngine,
  isReserveRosterSlotForEngine,
} from "./rosteredPlayersForSlots";
import { computeOpeningAuctionValueByPlayerId } from "./marketPressureOpeningValues";
import { getPlayerId } from "./playerId";
import { leagueSlotCapacity } from "../services/teamAdjustedBudget";
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  LeanPlayer,
  NormalizedValuationInput,
  ValuationResponse,
} from "../types/brain";
import type {
  AllocatorVsOpenSnapshot,
  BudgetPressureSnapshot,
  KeeperCompressionSnapshot,
  MarketInflationConfidence,
  MarketInflationPressure,
  MarketInflationStatus,
  MarketPressureSnapshot,
} from "../types/marketPressure";

/** Completed auction picks before status uses ratio thresholds. */
export const MARKET_INFLATION_MIN_SAMPLE = 3;
/** Below this count, status is `low_sample` when picks exist. */
export const MARKET_INFLATION_LOW_SAMPLE_MAX = 9;
export const MARKET_INFLATION_MEDIUM_CONFIDENCE_MIN = 10;
export const MARKET_INFLATION_HIGH_CONFIDENCE_MIN = 50;
export const MARKET_INFLATION_INFLATED_RATIO = 1.08;
export const MARKET_INFLATION_DEFLATED_RATIO = 0.92;

export const BUDGET_PRESSURE_TIGHT_CASH_TO_MASS = 0.35;
export const BUDGET_PRESSURE_LOOSE_CASH_TO_MASS = 0.55;
export const BUDGET_PRESSURE_TIGHT_DOLLARS_PER_SLOT = 13;
export const BUDGET_PRESSURE_LOOSE_DOLLARS_PER_SLOT = 16;

export const KEEPER_FILL_NONE = 0.1;
export const KEEPER_FILL_LOW = 0.25;
export const KEEPER_FILL_MODERATE = 0.4;

const ALLOCATOR_VS_OPEN_EXPLANATION =
  "Compares the model's current surplus allocator to a replayed auction-opening board. This is a technical comparator — not live auction inflation.";

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

function round4(n: number): number {
  return parseFloat(n.toFixed(4));
}

function iterPreDraftRows(
  preDraft: NormalizedValuationInput["pre_draft_rosters"]
): Array<Record<string, unknown>> {
  if (!preDraft) return [];
  const out: Array<Record<string, unknown>> = [];
  if (Array.isArray(preDraft)) {
    for (const bucket of preDraft) {
      const players = (bucket as { players?: unknown[] }).players;
      if (Array.isArray(players)) {
        for (const row of players) {
          if (typeof row === "object" && row != null) out.push(row as Record<string, unknown>);
        }
      }
    }
    return out;
  }
  for (const rows of Object.values(preDraft)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (typeof row === "object" && row != null) out.push(row as Record<string, unknown>);
    }
  }
  return out;
}

function sumKeeperSalaryCommitted(input: NormalizedValuationInput): number {
  let sum = 0;
  const addRow = (rec: Record<string, unknown>) => {
    if (rec.is_keeper !== true) return;
    const keeperCost = rec.keeper_cost;
    const paid = rec.paid;
    if (typeof keeperCost === "number" && Number.isFinite(keeperCost)) {
      sum += keeperCost;
    } else if (typeof paid === "number" && Number.isFinite(paid)) {
      sum += paid;
    }
  };
  for (const row of iterPreDraftRows(input.pre_draft_rosters)) {
    addRow(row);
  }
  for (const d of input.drafted_players) {
    if (isReserveRosterSlotForEngine(d.roster_slot)) continue;
    if (d.is_keeper === true) {
      const paid = d.paid ?? d.keeper_cost;
      if (typeof paid === "number" && Number.isFinite(paid)) sum += paid;
    }
  }
  return sum;
}

function activeAuctionPicks(input: NormalizedValuationInput): DraftedPlayer[] {
  return input.drafted_players.filter(
    (d) => !isReserveRosterSlotForEngine(d.roster_slot) && d.is_keeper !== true
  );
}

function inflationConfidence(sampleSize: number): MarketInflationConfidence {
  if (sampleSize <= 0) return "none";
  if (sampleSize < MARKET_INFLATION_MEDIUM_CONFIDENCE_MIN) return "low";
  if (sampleSize < MARKET_INFLATION_HIGH_CONFIDENCE_MIN) return "medium";
  return "high";
}

function inflationStatusFromRatio(
  sampleSize: number,
  ratio: number | null,
  confidence: MarketInflationConfidence
): MarketInflationStatus {
  if (sampleSize === 0) return "not_started";
  if (ratio == null || sampleSize < MARKET_INFLATION_MIN_SAMPLE) return "low_sample";
  if (confidence !== "high") return "low_sample";
  if (ratio >= MARKET_INFLATION_INFLATED_RATIO) return "inflated";
  if (ratio <= MARKET_INFLATION_DEFLATED_RATIO) return "deflated";
  return "neutral";
}

function buildMarketInflation(params: {
  input: NormalizedValuationInput;
  response: ValuationResponse;
  allPlayers: LeanPlayer[];
  inflationOptions?: CalculateInflationOptions;
}): MarketInflationPressure {
  const picks = activeAuctionPicks(params.input);
  const sampleSize = picks.length;
  const actualSpend = picks.reduce((s, d) => s + (d.paid ?? 0), 0);

  const catalogValueById = new Map<string, number>();
  for (const p of params.allPlayers) {
    catalogValueById.set(getPlayerId(p), p.value || 0);
  }

  let expectedSpend = 0;
  if (sampleSize > 0) {
    const openingById = computeOpeningAuctionValueByPlayerId({
      inflationModelEffective: params.response.inflation_model,
      draftedPlayers: params.input.drafted_players,
      scoped: params.allPlayers,
      rosterSlots: params.input.roster_slots,
      numTeams: params.input.num_teams,
      totalBudgetPerTeam: params.input.total_budget,
      budgetRemaining: params.response.total_budget_remaining,
      options: params.inflationOptions,
    });
    for (const pick of picks) {
      const openVal = openingById.get(pick.player_id);
      if (openVal != null && Number.isFinite(openVal)) {
        expectedSpend += openVal;
      } else {
        const row = params.response.valuations.find((v) => v.player_id === pick.player_id);
        expectedSpend +=
          row?.auction_value ??
          row?.baseline_value ??
          catalogValueById.get(pick.player_id) ??
          0;
      }
    }
  }

  const ratio =
    sampleSize > 0 && expectedSpend > 0
      ? round4(actualSpend / expectedSpend)
      : null;
  const percent = ratio != null ? round2((ratio - 1) * 100) : null;
  const confidence = inflationConfidence(sampleSize);
  const status = inflationStatusFromRatio(sampleSize, ratio, confidence);

  let label: string;
  let explanation: string;
  if (status === "not_started") {
    label = "Not started";
    explanation =
      "No completed non-keeper auction picks yet. Market inflation measures actual prices paid vs opening auction values once bidding begins.";
  } else if (status === "low_sample") {
    label = "Low sample";
    explanation = `Only ${sampleSize} auction pick${sampleSize === 1 ? "" : "s"} so far — ratio ${ratio != null ? `${ratio.toFixed(2)}×` : "n/a"} (${percent != null ? `${percent >= 0 ? "+" : ""}${percent}%` : "n/a"}) is indicative, not stable.`;
  } else if (status === "inflated") {
    label = "Inflated";
    explanation = `Auction prices are running hot: $${Math.round(actualSpend)} paid vs $${Math.round(expectedSpend)} expected at auction open (${ratio?.toFixed(2)}×, ${sampleSize} picks).`;
  } else if (status === "deflated") {
    label = "Deflated";
    explanation = `Auction prices are below opening expectations: $${Math.round(actualSpend)} paid vs $${Math.round(expectedSpend)} expected (${ratio?.toFixed(2)}×, ${sampleSize} picks).`;
  } else {
    label = "Neutral";
    explanation = `Auction spend is near opening expectations (${ratio?.toFixed(2)}× over ${sampleSize} picks).`;
  }

  return {
    status,
    ratio,
    percent,
    sample_size: sampleSize,
    actual_spend: round2(actualSpend),
    expected_spend: round2(expectedSpend),
    confidence,
    label,
    explanation,
  };
}

function budgetPressureStatus(
  cashToMass: number | null,
  dollarsPerSlot: number | null
): BudgetPressureSnapshot["status"] {
  if (cashToMass != null) {
    if (cashToMass < BUDGET_PRESSURE_TIGHT_CASH_TO_MASS) return "tight";
    if (cashToMass > BUDGET_PRESSURE_LOOSE_CASH_TO_MASS) return "loose";
  }
  if (dollarsPerSlot != null) {
    if (dollarsPerSlot < BUDGET_PRESSURE_TIGHT_DOLLARS_PER_SLOT) return "tight";
    if (dollarsPerSlot > BUDGET_PRESSURE_LOOSE_DOLLARS_PER_SLOT) return "loose";
  }
  return "balanced";
}

function buildBudgetPressure(
  response: ValuationResponse,
  keeperFillRatio: number,
): BudgetPressureSnapshot {
  const total_budget_remaining = response.total_budget_remaining;
  const remaining_active_slots = Math.max(0, response.remaining_slots ?? 0);
  const min_bid = response.min_bid ?? 1;
  const min_bid_reserve = remaining_active_slots * min_bid;
  const surplus_cash =
    response.surplus_cash ??
    Math.max(0, total_budget_remaining - min_bid_reserve);
  const total_surplus_mass =
    response.total_surplus_mass != null && Number.isFinite(response.total_surplus_mass)
      ? response.total_surplus_mass
      : null;
  const cash_to_surplus_mass_ratio =
    total_surplus_mass != null && total_surplus_mass > 0
      ? round4(surplus_cash / total_surplus_mass)
      : null;
  const dollars_per_open_slot =
    remaining_active_slots > 0
      ? round2(total_budget_remaining / remaining_active_slots)
      : null;

  let status = budgetPressureStatus(cash_to_surplus_mass_ratio, dollars_per_open_slot);
  if (
    keeperFillRatio >= KEEPER_FILL_MODERATE &&
    dollars_per_open_slot != null &&
    dollars_per_open_slot <= BUDGET_PRESSURE_LOOSE_DOLLARS_PER_SLOT
  ) {
    status = "tight";
  }

  let label: string;
  let explanation: string;
  if (status === "tight") {
    label = "Tight";
    explanation = `Surplus cash ($${Math.round(surplus_cash)}) is low vs marginal surplus mass${cash_to_surplus_mass_ratio != null ? ` (${cash_to_surplus_mass_ratio.toFixed(2)}×)` : ""} with ${remaining_active_slots} open slots ($${dollars_per_open_slot ?? "—"}/slot).`;
  } else if (status === "loose") {
    label = "Loose";
    explanation = `Plenty of budget headroom vs open slot demand (${remaining_active_slots} slots, $${Math.round(total_budget_remaining)} left).`;
  } else {
    label = "Balanced";
    explanation = `Budget vs open slots and surplus mass is in a middle band (${remaining_active_slots} slots remaining).`;
  }

  return {
    status,
    total_budget_remaining: round2(total_budget_remaining),
    remaining_active_slots,
    min_bid_reserve: round2(min_bid_reserve),
    surplus_cash: round2(surplus_cash),
    total_surplus_mass:
      total_surplus_mass != null ? round2(total_surplus_mass) : null,
    cash_to_surplus_mass_ratio,
    dollars_per_open_slot,
    label,
    explanation,
  };
}

function keeperCompressionStatus(fillRatio: number): KeeperCompressionSnapshot["status"] {
  if (fillRatio < KEEPER_FILL_NONE) return "none";
  if (fillRatio < KEEPER_FILL_LOW) return "low";
  if (fillRatio < KEEPER_FILL_MODERATE) return "moderate";
  return "high";
}

function buildKeeperCompression(
  input: NormalizedValuationInput
): KeeperCompressionSnapshot {
  const rostered = buildRosteredPlayersForSlotEngine(input);
  const active_keeper_count = rostered.filter((p) => p.is_keeper === true).length;
  const active_capacity = leagueSlotCapacity(input.roster_slots, input.num_teams);
  const keeper_slot_fill_ratio =
    active_capacity > 0 ? round4(active_keeper_count / active_capacity) : 0;
  const keeper_salary_committed = round2(sumKeeperSalaryCommitted(input));
  const total_league_budget = input.total_budget * input.num_teams;
  const keeper_budget_share =
    total_league_budget > 0
      ? round4(keeper_salary_committed / total_league_budget)
      : 0;
  const status = keeperCompressionStatus(keeper_slot_fill_ratio);

  const labelByStatus: Record<KeeperCompressionSnapshot["status"], string> = {
    none: "None",
    low: "Low",
    moderate: "Moderate",
    high: "High",
  };

  return {
    status,
    active_keeper_count,
    active_capacity,
    keeper_slot_fill_ratio,
    keeper_salary_committed,
    total_league_budget: round2(total_league_budget),
    keeper_budget_share,
    label: labelByStatus[status],
    explanation: `${active_keeper_count} of ${active_capacity} active slots (${(keeper_slot_fill_ratio * 100).toFixed(0)}%) held by keepers; $${Math.round(keeper_salary_committed)} (${(keeper_budget_share * 100).toFixed(0)}%) of league budget committed before open bidding.`,
  };
}

function readRatio(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return round4(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return round4(n);
  }
  return null;
}

function buildAllocatorVsOpen(response: ValuationResponse): AllocatorVsOpenSnapshot {
  const ratio = readRatio(response.inflation_index_vs_opening_auction);
  const percent =
    ratio != null
      ? round2((ratio - 1) * 100)
      : response.inflation_percent_vs_auction_open != null
        ? round2(response.inflation_percent_vs_auction_open)
        : null;

  return {
    ratio,
    percent,
    label: "Allocator vs Open",
    explanation: ALLOCATOR_VS_OPEN_EXPLANATION,
  };
}

export function buildMarketPressureSnapshot(params: {
  response: ValuationResponse;
  input: NormalizedValuationInput;
  allPlayers: LeanPlayer[];
  inflationOptions?: CalculateInflationOptions;
}): MarketPressureSnapshot {
  const keeper_compression = buildKeeperCompression(params.input);
  return {
    market_inflation: buildMarketInflation(params),
    budget_pressure: buildBudgetPressure(
      params.response,
      keeper_compression.keeper_slot_fill_ratio
    ),
    keeper_compression,
    allocator_vs_open: buildAllocatorVsOpen(params.response),
  };
}
