import { ENGINE_CONTRACT_VERSION } from "../lib/engineContract";
import { getValuationModelVersion } from "../lib/valuationModelVersion";
import { isSymmetricOpenLeagueContext } from "../lib/symmetricLeagueOpen";
import { filterByScope } from "../lib/leagueScope";
import { computeReplacementSlotsV2 } from "./replacementSlotsV2";
import {
  buildLeagueSlotDemand,
  fitsRosterSlot,
  playerTokensFromDrafted,
  playerTokensFromLean,
  sumDemand,
} from "../lib/fantasyRosterSlots";
import type {
  CalculateInflationOptions,
  DraftedPlayer,
  DraftPhaseIndicator,
  InflationBoundedBy,
  InflationModel,
  LeanPlayer,
  LeagueScope,
  RosterSlot,
  ValuedPlayer,
  ValueIndicator,
  ValuationResponse,
} from "../types/brain";

/**
 * A player is a "Steal" if ADP rank is significantly later than value rank
 * (the market undervalues them) and a "Reach" if ADP rank is significantly
 * earlier than value rank (the market overvalues them).
 */
const STEAL_SLOPE = 1.25; // ADP rank ≥ 25% later than value rank
const REACH_SLOPE = 0.75; // ADP rank ≥ 25% earlier than value rank

const DETERMINISTIC_CALCULATED_AT = "1970-01-01T00:00:00.000Z";

/** Minimum auction bid reserved per empty roster slot (surplus model). */
const MIN_AUCTION_BID = 1;
const RECOMMENDED_BID_NOTE =
  "recommended_bid is a phase-aware model clearing target (star floors, pitcher dampening, isotonic smoothing)—a bidding guide, not a prediction of the winning hammer price; room behavior can diverge materially.";
const TEAM_ADJUSTED_NOTE =
  "team_adjusted_value scales adjusted_value by roster need, dollars per open slot vs league peers, remaining-slot scarcity, and replacement drop-off for eligible slots; when the league snapshot is symmetric (no auction picks, no keeper/minors/taxi off-board ids, equal per-team budgets in budget_by_team_id when provided, equal rostered counts per team), it equals adjusted_value";
const DEFAULT_USER_TEAM_ID = "team_1";

const FLEX_SLOTS = new Set(["UTIL", "CI", "MI", "P"]);

/** Draftable pool size = ceil(remaining_slots × multiplier), capped by undrafted count. */
const DEFAULT_SURPLUS_DRAFTABLE_MULTIPLIER = 1.35;

/**
 * Returns the canonical ID used to match this player against drafted_players.
 * Prefers mlbId (string) since that's what Draftroom sends; falls back to _id.
 */
export function getPlayerId(player: LeanPlayer): string {
  return player.mlbId != null ? String(player.mlbId) : String(player._id);
}

/** Deterministic 32-bit mix for seeded tie-breaks (grading / CI). */
function hash32(seed: number, s: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i);
    h >>>= 0;
  }
  return h >>> 0;
}

function compareByValueDesc(
  a: LeanPlayer,
  b: LeanPlayer,
  options?: CalculateInflationOptions
): number {
  const diff = (b.value || 0) - (a.value || 0);
  if (diff !== 0) return diff;
  if (
    options?.deterministic &&
    options.seed != null &&
    Number.isFinite(options.seed)
  ) {
    return (
      hash32(options.seed, getPlayerId(a)) - hash32(options.seed, getPlayerId(b))
    );
  }
  return getPlayerId(a).localeCompare(getPlayerId(b));
}

function compareByAdpAsc(
  a: LeanPlayer,
  b: LeanPlayer,
  options?: CalculateInflationOptions
): number {
  const diff = (a.adp || 9999) - (b.adp || 9999);
  if (diff !== 0) return diff;
  if (
    options?.deterministic &&
    options.seed != null &&
    Number.isFinite(options.seed)
  ) {
    return (
      hash32(options.seed, getPlayerId(a)) - hash32(options.seed, getPlayerId(b))
    );
  }
  return getPlayerId(a).localeCompare(getPlayerId(b));
}

function clampInflation(
  raw: number,
  cap: number | undefined,
  floor: number | undefined
): {
  inflation_raw: number;
  inflation_factor: number;
  inflation_bounded_by: InflationBoundedBy;
} {
  const capV =
    cap != null && Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
  const floorV =
    floor != null && Number.isFinite(floor) && floor > 0 ? floor : 0.25;
  const capped = Math.min(capV, raw);
  const applied = Math.max(floorV, capped);
  const eps = 1e-5;
  let inflation_bounded_by: InflationBoundedBy = "none";
  if (applied > raw + eps) inflation_bounded_by = "floor";
  else if (applied + eps < raw) inflation_bounded_by = "cap";
  return { inflation_raw: raw, inflation_factor: applied, inflation_bounded_by };
}

function isStartingSlot(slot: string): boolean {
  return slot.toUpperCase() !== "BN";
}

function slotPriorityScore(slot: string): number {
  const u = slot.toUpperCase();
  if (u === "C") return 10;
  if (u === "SS") return 20;
  if (u === "2B") return 30;
  if (u === "3B") return 40;
  if (u === "1B") return 50;
  if (u === "OF") return 60;
  if (u === "SP") return 70;
  if (u === "RP") return 80;
  if (u === "UTIL") return 90;
  if (u === "CI") return 100;
  if (u === "MI") return 110;
  if (u === "P") return 120;
  return 200;
}

function buildOpenSlotsForUserTeam(
  rosterSlots: RosterSlot[],
  rosteredPlayersForSlots: DraftedPlayer[] | undefined,
  userTeamId: string
): Map<string, number> {
  const open = new Map<string, number>();
  for (const rs of rosterSlots) {
    const slot = rs.position.toUpperCase().trim();
    if (!slot || !isStartingSlot(slot)) continue;
    open.set(slot, (open.get(slot) ?? 0) + Math.max(0, Math.floor(rs.count ?? 0)));
  }
  const teamRows = (rosteredPlayersForSlots ?? []).filter(
    (p) => p.team_id === userTeamId
  );
  const sortedSlots = [...open.keys()].sort(
    (a, b) => slotPriorityScore(a) - slotPriorityScore(b)
  );
  for (const row of teamRows) {
    const tokens = playerTokensFromDrafted(row);
    for (const slot of sortedSlots) {
      const need = open.get(slot) ?? 0;
      if (need <= 0) continue;
      if (!fitsRosterSlot(slot, tokens)) continue;
      open.set(slot, need - 1);
      break;
    }
  }
  return open;
}

function positionalNeedMultiplier(
  p: LeanPlayer,
  openSlots: Map<string, number>
): number {
  const tokens = playerTokensFromLean(p);
  const slots = [...openSlots.keys()];
  const hasOpenPrimary = slots.some((slot) => {
    const u = slot.toUpperCase();
    return (
      !FLEX_SLOTS.has(u) &&
      (openSlots.get(slot) ?? 0) > 0 &&
      fitsRosterSlot(slot, tokens)
    );
  });
  if (hasOpenPrimary) return 1.25;

  const hasOpenFlex = slots.some((slot) => {
    const u = slot.toUpperCase();
    return FLEX_SLOTS.has(u) && (openSlots.get(slot) ?? 0) > 0 && fitsRosterSlot(u, tokens);
  });
  if (hasOpenFlex) return 1.1;

  const fitsAnyStarting = slots.some((slot) => fitsRosterSlot(slot, tokens));
  if (fitsAnyStarting) return 0.85;

  return 1.0;
}

function budgetPressureMultiplier(
  draftedPlayers: DraftedPlayer[],
  totalBudgetPerTeam: number,
  numTeams: number,
  budgetByTeamId: Record<string, number> | undefined,
  userTeamId: string,
  budgetRemaining: number
): number {
  let userRemaining: number;
  let leagueAvgRemaining: number;

  if (budgetByTeamId && Object.keys(budgetByTeamId).length > 0) {
    userRemaining = budgetByTeamId[userTeamId] ?? totalBudgetPerTeam;
    leagueAvgRemaining =
      Object.values(budgetByTeamId).reduce((s, v) => s + v, 0) /
      Math.max(1, Object.keys(budgetByTeamId).length);
  } else {
    let userSpent = 0;
    for (const dp of draftedPlayers) {
      if (dp.team_id !== userTeamId) continue;
      userSpent += dp.paid ?? 0;
    }
    userRemaining = Math.max(0, totalBudgetPerTeam - userSpent);
    leagueAvgRemaining = budgetRemaining / Math.max(1, numTeams);
  }

  if (userRemaining > 1.25 * leagueAvgRemaining) return 1.15;
  if (userRemaining < 0.75 * leagueAvgRemaining) return 0.85;
  return 1.0;
}

function userBudgetRemaining(
  draftedPlayers: DraftedPlayer[],
  totalBudgetPerTeam: number,
  budgetByTeamId: Record<string, number> | undefined,
  userTeamId: string
): number {
  if (budgetByTeamId && Object.keys(budgetByTeamId).length > 0) {
    return budgetByTeamId[userTeamId] ?? totalBudgetPerTeam;
  }
  let spent = 0;
  for (const dp of draftedPlayers) {
    if (dp.team_id !== userTeamId) continue;
    spent += dp.paid ?? 0;
  }
  return Math.max(0, totalBudgetPerTeam - spent);
}

function leagueSlotCapacity(rosterSlots: RosterSlot[], numTeams: number): number {
  return sumDemand(buildLeagueSlotDemand(rosterSlots, numTeams));
}

function userTeamStartingSlots(rosterSlots: RosterSlot[]): number {
  let s = 0;
  for (const rs of rosterSlots) {
    const u = rs.position.toUpperCase().trim();
    if (!u || u === "BN") continue;
    s += Math.max(0, Math.floor(rs.count ?? 0));
  }
  return s;
}

function resolveDraftPhase(params: {
  rosterSlots: RosterSlot[];
  numTeams: number;
  remainingSlotsLeague: number;
  draftedCount: number;
}): DraftPhaseIndicator {
  const cap = leagueSlotCapacity(params.rosterSlots, params.numTeams);
  let fill = 0;
  if (cap > 0 && Number.isFinite(params.remainingSlotsLeague)) {
    fill = (cap - params.remainingSlotsLeague) / cap;
  } else if (cap > 0) {
    fill = Math.min(1, params.draftedCount / cap);
  }
  fill = Math.max(0, Math.min(1, fill));
  if (fill < 0.33) return "early";
  if (fill < 0.67) return "mid";
  return "late";
}

function lambdaClearingPrice(
  phase: DraftPhaseIndicator,
  depthFrac: number
): number {
  const t = Math.max(0, Math.min(1, depthFrac));
  const elite = 1 - t;
  switch (phase) {
    case "early":
      return 0.5 + 0.28 * elite ** 1.25;
    case "mid":
      return 0.42 + 0.24 * elite ** 1.15;
    case "late":
      return 0.18 + 0.22 * elite ** 1.25;
    default:
      return 0.46;
  }
}

function isotonicNonIncreasing(values: number[]): number[] {
  if (values.length <= 1) return [...values];
  const blocks: Array<{ sum: number; count: number }> = [];
  for (const v of values) {
    blocks.push({ sum: v, count: 1 });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      const meanA = a.sum / a.count;
      const meanB = b.sum / b.count;
      if (meanA >= meanB) break;
      blocks.splice(blocks.length - 2, 2, {
        sum: a.sum + b.sum,
        count: a.count + b.count,
      });
    }
  }
  const out: number[] = [];
  for (const b of blocks) {
    const m = b.sum / b.count;
    for (let i = 0; i < b.count; i++) out.push(m);
  }
  return out;
}

function isPitcherPosition(pos: string): boolean {
  const toks = pos.toUpperCase().split(/[,/ ]+/).filter(Boolean);
  return toks.some((t) => t === "SP" || t === "RP" || t === "P");
}

function maxReplacementDropoff(
  baseline: number,
  tokens: readonly string[],
  repl: Record<string, number>,
  slotKeys: ReadonlySet<string>
): number {
  let best = 0;
  for (const slot of slotKeys) {
    if (!fitsRosterSlot(slot, tokens)) continue;
    best = Math.max(best, baseline - (repl[slot] ?? 0));
  }
  return Math.max(0, best);
}

function bestReplacementForPlayer(
  tokens: readonly string[],
  repl: Record<string, number>,
  slotKeys: ReadonlySet<string>
): { key: string; value: number } | null {
  let best: { key: string; value: number } | null = null;
  for (const slot of slotKeys) {
    if (!fitsRosterSlot(slot, tokens)) continue;
    const v = repl[slot];
    if (v == null || !Number.isFinite(v)) continue;
    if (!best || v < best.value) best = { key: slot, value: v };
  }
  return best;
}

function dollarsPerSlotPeerRatio(params: {
  userRemaining: number;
  openSeatTotal: number;
  budgetRemainingLeague: number;
  numTeams: number;
  remainingSlotsLeague: number;
}): number {
  const dpsUser = params.userRemaining / Math.max(1, params.openSeatTotal);
  const peerOpen = Math.max(1, params.remainingSlotsLeague / params.numTeams);
  const peerBudget = params.budgetRemainingLeague / Math.max(1, params.numTeams);
  const dpsPeer = peerBudget / peerOpen;
  if (!Number.isFinite(dpsPeer) || dpsPeer <= 0) return 1;
  return dpsUser / dpsPeer;
}

function computeRecommendedBid(params: {
  row: ValuedPlayer;
  draftPhase: DraftPhaseIndicator;
  depthFrac: number;
  inflationIndexVsOpeningAuction: number | undefined;
}): number {
  const { row, draftPhase, depthFrac, inflationIndexVsOpeningAuction } = params;
  const a = row.adjusted_value;
  const r = row.baseline_value;
  const nearAuctionOpenNeutral =
    inflationIndexVsOpeningAuction != null &&
    Math.abs(inflationIndexVsOpeningAuction - 1) <= 0.08;
  let L = lambdaClearingPrice(draftPhase, depthFrac);
  // Pitcher markets in our replay clear closer to marginal (adjusted_value) than list anchor.
  if (isPitcherPosition(row.position)) {
    const damp =
      draftPhase === "early" ? 0.52 : draftPhase === "mid" ? 0.44 : 0.38;
    L *= damp;
  }
  let clearing = a + L * (r - a);
  if (draftPhase === "early" && depthFrac < 0.06) {
    clearing += 0.045 * (r - a);
  }
  if (draftPhase === "late") {
    const squeeze = 0.5 + 0.5 * (1 - depthFrac);
    clearing =
      MIN_AUCTION_BID + (clearing - MIN_AUCTION_BID) * Math.max(0.35, squeeze);
  }
  if (!isPitcherPosition(row.position) && draftPhase !== "late" && depthFrac < 0.45) {
    // Early/mid hitter markets tend to clear materially above pure marginal value.
    const hitterMarketFloor = Math.min(
      Math.max(a + 2, r * 0.72),
      a * 1.6 + 4
    );
    clearing = Math.max(clearing, hitterMarketFloor);
  }
  if (!isPitcherPosition(row.position) && draftPhase !== "late" && depthFrac < 0.28) {
    // Additional star-tier floor so top bats don't collapse into marginal pricing.
    const starHitterFloor = Math.max(a + 4, r * 0.58);
    clearing = Math.max(clearing, starHitterFloor);
  }
  if (depthFrac < 0.12) {
    clearing = Math.max(clearing, a * 0.93);
  }
  // Late: star hitter with huge baseline but surplus-crushed adjusted — cap anchor drag (paid replay).
  if (
    !isPitcherPosition(row.position) &&
    draftPhase === "late" &&
    depthFrac > 0.52 &&
    r > 32 &&
    a > 0 &&
    a < r * 0.45
  ) {
    clearing = Math.min(clearing, a + (r - a) * 0.22);
  }
  // Mid/early: ace-tier SP with tiny adjusted — lift clearing off the $1 floor toward hybrid anchor.
  if (
    isPitcherPosition(row.position) &&
    draftPhase !== "late" &&
    depthFrac < 0.5 &&
    r > 26 &&
    a > 0 &&
    a < 18
  ) {
    clearing = Math.max(
      clearing,
      Math.min(r * 0.42, a * 2.55 + 10),
      a + 3
    );
  }
  // Early auction with index ~1.0: keep SP clearing guidance close to
  // modeled marginal value; avoids ace/SP2 recommendations that outrun
  // realistic opening-room clears in neutral conditions.
  if (
    isPitcherPosition(row.position) &&
    draftPhase === "early" &&
    nearAuctionOpenNeutral &&
    a > 0
  ) {
    const neutralCeil = Math.max(a + 5, a * 1.45);
    clearing = Math.min(clearing, neutralCeil);
  }
  const hiSoft = Math.max(r, a) * 1.15 + 8;
  return Math.max(MIN_AUCTION_BID, Math.min(clearing, hiSoft));
}

function smoothRecommendedBids(valuations: ValuedPlayer[]): void {
  const smoothGroup = (rows: ValuedPlayer[]) => {
    const ordDesc = [...rows].sort((a, b) => b.baseline_value - a.baseline_value);
    const recSeries = ordDesc.map((r) => r.recommended_bid ?? MIN_AUCTION_BID);
    const smoothed = isotonicNonIncreasing(recSeries);
    for (let k = 0; k < ordDesc.length; k++) {
      ordDesc[k].recommended_bid = parseFloat(
        Math.max(MIN_AUCTION_BID, smoothed[k] ?? MIN_AUCTION_BID).toFixed(2)
      );
    }
  };
  smoothGroup(valuations.filter((r) => !isPitcherPosition(r.position)));
  smoothGroup(valuations.filter((r) => isPitcherPosition(r.position)));
}

function computeTeamAdjustedValue(params: {
  row: ValuedPlayer;
  lp: LeanPlayer;
  openSlots: Map<string, number>;
  budgetMult: number;
  dpsMult: number;
  slotScarcityMult: number;
  replForTeam: Record<string, number>;
  rosterSlotKeysForFit: ReadonlySet<string>;
}): number {
  const {
    row,
    lp,
    openSlots,
    budgetMult,
    dpsMult,
    slotScarcityMult,
    replForTeam,
    rosterSlotKeysForFit,
  } = params;
  const needMult = positionalNeedMultiplier(lp, openSlots);
  const tokens = playerTokensFromLean(lp);
  const drop = maxReplacementDropoff(
    row.baseline_value,
    tokens,
    replForTeam,
    rosterSlotKeysForFit
  );
  const dropMult =
    Object.keys(replForTeam).length > 0
      ? 1 + 0.22 * Math.min(1.25, drop / Math.max(8, row.baseline_value))
      : 1;
  const rawTeam =
    row.adjusted_value *
    needMult *
    budgetMult *
    dpsMult *
    slotScarcityMult *
    dropMult;
  const saneCap = Math.min(
    8000,
    Math.max(
      row.adjusted_value * 6,
      row.baseline_value * 4 + row.adjusted_value
    )
  );
  return parseFloat(Math.max(0, Math.min(saneCap, rawTeam)).toFixed(2));
}

type SurplusPlan = {
  replacementValue: number;
  poolSurplusSum: number;
  surplusCash: number;
};

type InflationModelSelection = {
  inflationModelEffective: InflationModel;
  poolValueRemaining: number;
  rawInflationFactor: number;
  replacementValue: number;
  v2Meta: Partial<ValuationResponse>;
  v2Result: ReturnType<typeof computeReplacementSlotsV2> | null;
};

function tryBuildSurplusPlan(
  byValueFull: LeanPlayer[],
  undraftedCount: number,
  remainingSlots: number,
  budgetRemaining: number,
  options?: CalculateInflationOptions
): SurplusPlan | null {
  if (remainingSlots <= 0 || undraftedCount === 0) return null;
  const mult =
    options?.surplusDraftablePoolMultiplier ?? DEFAULT_SURPLUS_DRAFTABLE_MULTIPLIER;
  const k = Math.min(undraftedCount, Math.ceil(remainingSlots * mult));
  if (k < 1) return null;
  const draftable = byValueFull.slice(0, k);
  const replacementValue = draftable[draftable.length - 1]?.value ?? 0;
  let poolSurplusSum = 0;
  for (const p of draftable) {
    poolSurplusSum += Math.max(0, (p.value || 0) - replacementValue);
  }
  if (poolSurplusSum <= 0) return null;
  const surplusCash = Math.max(
    0,
    budgetRemaining - remainingSlots * MIN_AUCTION_BID
  );
  return { replacementValue, poolSurplusSum, surplusCash };
}

function computeBudgetRemaining(params: {
  draftedPlayers: DraftedPlayer[];
  totalBudgetPerTeam: number;
  numTeams: number;
  budgetByTeamId?: Record<string, number>;
  additionalSpent?: number;
}): number {
  const {
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId,
    additionalSpent,
  } = params;
  if (budgetByTeamId && Object.keys(budgetByTeamId).length > 0) {
    return Object.values(budgetByTeamId).reduce((sum, v) => sum + v, 0);
  }
  const totalLeagueBudget = totalBudgetPerTeam * numTeams;
  const budgetSpent = draftedPlayers.reduce((sum, dp) => sum + (dp.paid ?? 0), 0);
  return Math.max(0, totalLeagueBudget - budgetSpent - (additionalSpent ?? 0));
}

function selectInflationModel(params: {
  requestedModel: InflationModel;
  scoped: LeanPlayer[];
  undraftedFull: LeanPlayer[];
  byValueFull: LeanPlayer[];
  draftedPlayers: DraftedPlayer[];
  rosterSlots: RosterSlot[];
  numTeams: number;
  budgetRemaining: number;
  options?: CalculateInflationOptions;
  poolValueFull: number;
}): InflationModelSelection {
  const {
    requestedModel,
    scoped,
    undraftedFull,
    byValueFull,
    draftedPlayers,
    rosterSlots,
    numTeams,
    budgetRemaining,
    options,
    poolValueFull,
  } = params;

  if (requestedModel === "replacement_slots_v2") {
    const rostered = options?.rosteredPlayersForSlots ?? draftedPlayers;
    const baselineById = new Map<string, number>();
    for (const p of scoped) {
      baselineById.set(getPlayerId(p), p.value || 0);
    }
    const v2Result = computeReplacementSlotsV2(
      undraftedFull,
      rostered,
      rosterSlots,
      numTeams,
      budgetRemaining,
      baselineById,
      {
        deterministic: options?.deterministic,
        seed: options?.seed,
      }
    );
    return {
      inflationModelEffective: "replacement_slots_v2",
      poolValueRemaining: v2Result.pool_value_remaining,
      rawInflationFactor: v2Result.inflation_factor_precap,
      replacementValue: 0,
      v2Meta: {
        remaining_slots: v2Result.remaining_slots,
        min_bid: v2Result.min_bid,
        surplus_cash: v2Result.surplus_cash,
        total_surplus_mass: v2Result.total_surplus_mass,
        draftable_pool_size: v2Result.draftablePoolSize,
        replacement_values_by_slot_or_position:
          v2Result.replacement_values_by_slot_or_position,
        fallback_reason: v2Result.fallback_reason,
      },
      v2Result,
    };
  }

  const surplusPlan =
    requestedModel === "surplus_slots_v1"
      ? tryBuildSurplusPlan(
          byValueFull,
          undraftedFull.length,
          options?.remainingLeagueSlots ?? -1,
          budgetRemaining,
          options
        )
      : null;

  if (surplusPlan) {
    return {
      inflationModelEffective: "surplus_slots_v1",
      poolValueRemaining: surplusPlan.poolSurplusSum,
      rawInflationFactor:
        surplusPlan.poolSurplusSum > 0
          ? surplusPlan.surplusCash / surplusPlan.poolSurplusSum
          : 1,
      replacementValue: surplusPlan.replacementValue,
      v2Meta: {},
      v2Result: null,
    };
  }

  return {
    inflationModelEffective: "global_v1",
    poolValueRemaining: poolValueFull,
    rawInflationFactor: poolValueFull > 0 ? budgetRemaining / poolValueFull : 1,
    replacementValue: 0,
    v2Meta: {},
    v2Result: null,
  };
}

function computeInflationIndexVsOpeningAuction(params: {
  inflationModelEffective: InflationModel;
  v2Result: ReturnType<typeof computeReplacementSlotsV2> | null;
  options?: CalculateInflationOptions;
  draftedPlayers: DraftedPlayer[];
  scoped: LeanPlayer[];
  rosterSlots: RosterSlot[];
  numTeams: number;
  budgetRemaining: number;
  inflationFactor: number;
}): number | undefined {
  const {
    inflationModelEffective,
    v2Result,
    options,
    draftedPlayers,
    scoped,
    rosterSlots,
    numTeams,
    budgetRemaining,
    inflationFactor,
  } = params;
  if (inflationModelEffective !== "replacement_slots_v2" || !v2Result) {
    return undefined;
  }
  const rostered = options?.rosteredPlayersForSlots ?? draftedPlayers;
  const auctionAcquiredIds = new Set(
    draftedPlayers.filter((d) => d.is_keeper !== true).map((d) => d.player_id)
  );
  const rosteredOpen = rostered.filter((r) => !auctionAcquiredIds.has(r.player_id));
  const offBoardOpen = new Set(rosteredOpen.map((r) => r.player_id));
  for (const pid of options?.additionalDraftedIds ?? []) {
    offBoardOpen.add(pid);
  }
  const undraftedOpen = scoped.filter((p) => !offBoardOpen.has(getPlayerId(p)));
  const auctionSpend = draftedPlayers
    .filter((d) => d.is_keeper !== true)
    .reduce((sum, d) => sum + (d.paid ?? 0), 0);
  const budgetOpen = Math.max(0, budgetRemaining + auctionSpend);
  const baselineByIdOpen = new Map<string, number>();
  for (const p of scoped) {
    baselineByIdOpen.set(getPlayerId(p), p.value || 0);
  }
  const v2Open = computeReplacementSlotsV2(
    undraftedOpen,
    rosteredOpen,
    rosterSlots,
    numTeams,
    budgetOpen,
    baselineByIdOpen,
    {
      deterministic: options?.deterministic,
      seed: options?.seed,
    }
  );
  let openClamped = clampInflation(
    v2Open.inflation_factor_precap,
    options?.inflationCap,
    options?.inflationFloor
  );
  if (v2Open.skip_inflation_clamp) {
    openClamped = {
      inflation_raw: v2Open.inflation_raw,
      inflation_factor: v2Open.inflation_factor_precap,
      inflation_bounded_by: "none",
    };
  }
  const fOpen = openClamped.inflation_factor;
  if (fOpen > 1e-9 && Number.isFinite(inflationFactor)) {
    const ratio = inflationFactor / fOpen;
    if (Number.isFinite(ratio) && ratio > 0) {
      return parseFloat(ratio.toFixed(4));
    }
  }
  return undefined;
}

/**
 * Calculates auction inflation and returns adjusted player valuations.
 *
 * **Budget (contract):**
 * - If `options.budgetByTeamId` is non-empty: `total_budget_remaining` = **sum of map values**
 *   (per-team **remaining** dollars). **`paid` on `drafted_players` is ignored** for that request.
 * - Otherwise: `total_budget_remaining` = `total_budget * num_teams` − **sum(`drafted_players[].paid`)**
 *   (missing `paid` treated as 0). **`pre_draft_rosters`, `minors`, and `taxi` do not affect spend in v1.**
 *
 * **`inflation_model`:**
 * - `global_v1` — `inflation_factor` ≈ remaining budget ÷ sum of baseline $ on the **full** undrafted pool;
 *   `adjusted_value` = `baseline_value × inflation_factor`.
 * - `surplus_slots_v1` — reserves `MIN_AUCTION_BID` per remaining empty roster slot, builds a
 *   top-by-baseline draftable slice sized from those slots, sets replacement at the slice floor,
 *   then `inflation_raw = surplus_cash / Σ max(0, baseline − replacement)` on that slice and
 *   `adjusted_value = MIN_AUCTION_BID + inflation_factor × max(0, baseline − replacement)` for
 *   every undrafted row. Falls back to `global_v1` math when the surplus plan is degenerate.
 * - `replacement_slots_v2` — slot/position-aware replacement levels + surplus allocation
 *   (preferred for Draftroom). Never falls back to `global_v1`; see response metadata.
 *
 * **`player_ids`:** does not change the inflation denominator; it only filters
 * which rows appear in `valuations[]` (same parameters applied to each).
 *
 * Value Indicator:
 *   Ranks use the **full** undrafted pool so Steal/Reach stay meaningful when
 *   `valuations[]` is a subset.
 */
export function calculateInflation(
  allPlayers: LeanPlayer[],
  draftedPlayers: DraftedPlayer[],
  totalBudgetPerTeam: number,
  numTeams: number,
  rosterSlots: RosterSlot[],
  leagueScope: LeagueScope = "Mixed",
  options?: CalculateInflationOptions
): ValuationResponse {
  const requestedModel: InflationModel =
    options?.inflationModel ?? "global_v1";

  const draftedIds = new Set(draftedPlayers.map((d) => d.player_id));
  for (const pid of options?.additionalDraftedIds ?? []) {
    draftedIds.add(pid);
  }

  const scoped = filterByScope(allPlayers, leagueScope);
  const undraftedFull = scoped.filter((p) => !draftedIds.has(getPlayerId(p)));

  let undraftedForRows = undraftedFull;
  if (options?.playerIdsFilter && options.playerIdsFilter.length > 0) {
    const allow = new Set(options.playerIdsFilter);
    undraftedForRows = undraftedFull.filter((p) => allow.has(getPlayerId(p)));
  }

  const budgetRemaining = computeBudgetRemaining({
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    budgetByTeamId: options?.budgetByTeamId,
    additionalSpent: options?.additionalSpent,
  });

  const poolValueFull = undraftedFull.reduce((sum, p) => sum + (p.value || 0), 0);

  const byValueFull = [...undraftedFull].sort((a, b) =>
    compareByValueDesc(a, b, options)
  );
  const byAdpFull = [...undraftedFull].sort((a, b) =>
    compareByAdpAsc(a, b, options)
  );
  const valueRank = new Map(
    byValueFull.map((p, i) => [getPlayerId(p), i + 1])
  );
  const adpRank = new Map(byAdpFull.map((p, i) => [getPlayerId(p), i + 1]));
  const n = undraftedFull.length;

  const byValueRows = [...undraftedForRows].sort((a, b) =>
    compareByValueDesc(a, b, options)
  );

  const modelSelection = selectInflationModel({
    requestedModel,
    scoped,
    undraftedFull,
    byValueFull,
    draftedPlayers,
    rosterSlots,
    numTeams,
    budgetRemaining,
    options,
    poolValueFull,
  });
  const inflationModelEffective = modelSelection.inflationModelEffective;
  const poolValueRemaining = modelSelection.poolValueRemaining;
  const rawInflationFactor = modelSelection.rawInflationFactor;
  const replacementValue = modelSelection.replacementValue;
  const v2Meta = modelSelection.v2Meta;
  const v2Result = modelSelection.v2Result;

  let clamped = clampInflation(
    rawInflationFactor,
    options?.inflationCap,
    options?.inflationFloor
  );
  if (
    inflationModelEffective === "replacement_slots_v2" &&
    v2Result?.skip_inflation_clamp
  ) {
    clamped = {
      inflation_raw: v2Result.inflation_raw,
      inflation_factor: v2Result.inflation_factor_precap,
      inflation_bounded_by: "none",
    };
  }
  const inflationFactor = clamped.inflation_factor;
  const inflationRaw = clamped.inflation_raw;
  const inflationBoundedBy = clamped.inflation_bounded_by;

  const inflationIndexVsOpeningAuction = computeInflationIndexVsOpeningAuction({
    inflationModelEffective,
    v2Result,
    options,
    draftedPlayers,
    scoped,
    rosterSlots,
    numTeams,
    budgetRemaining,
    inflationFactor,
  });

  const valuations: ValuedPlayer[] = byValueRows.map((p) => {
    const pid = getPlayerId(p);
    const baselineValue = p.value || 0;
    let adjustedValue: number;
    if (inflationModelEffective === "replacement_slots_v2" && v2Result) {
      const sb = v2Result.playerIdToSurplusBasis.get(pid) ?? 0;
      if (v2Result.baselineOnly) {
        adjustedValue = parseFloat(baselineValue.toFixed(2));
      } else if (
        v2Result.fallback_reason === "no_surplus_mass" &&
        v2Result.surplus_cash > 0
      ) {
        adjustedValue = parseFloat(
          Math.max(MIN_AUCTION_BID, baselineValue).toFixed(2)
        );
      } else {
        adjustedValue = parseFloat(
          (MIN_AUCTION_BID + inflationFactor * sb).toFixed(2)
        );
      }
    } else if (inflationModelEffective === "surplus_slots_v1") {
      adjustedValue = parseFloat(
        (
          MIN_AUCTION_BID +
          inflationFactor * Math.max(0, baselineValue - replacementValue)
        ).toFixed(2)
      );
    } else {
      adjustedValue = parseFloat(
        (baselineValue * inflationFactor).toFixed(2)
      );
    }
    const meta = (
      p.projection as
        | {
            __valuation_meta__?: {
              scoring_format?: "5x5" | "6x6" | "points";
              projection_component?: number;
              scarcity_component?: number;
            };
          }
        | undefined
    )?.__valuation_meta__;

    let indicator: ValueIndicator = "Fair Value";
    if (n > 0) {
      const vRank = valueRank.get(pid) ?? 0;
      const aRank = adpRank.get(pid) ?? 0;
      if (aRank > vRank * STEAL_SLOPE) indicator = "Steal";
      else if (aRank < vRank * REACH_SLOPE) indicator = "Reach";
    }

    return {
      player_id: pid,
      name: p.name,
      position: p.position,
      team: p.team,
      adp: p.adp || 0,
      tier: p.tier || 0,
      baseline_value: baselineValue,
      adjusted_value: adjustedValue,
      indicator,
      inflation_factor: parseFloat(inflationFactor.toFixed(4)),
      baseline_components: {
        scoring_format: meta?.scoring_format ?? "default",
        projection_component: meta?.projection_component ?? 0,
        scarcity_component: meta?.scarcity_component ?? 0,
      },
      // scarcity_adjustment: always 0 — roster/scarcity is in baseline_value (baseline_components).
      scarcity_adjustment: 0,
      // inflation_adjustment: full delta from inflation pass (adjusted − baseline).
      inflation_adjustment: parseFloat((adjustedValue - baselineValue).toFixed(2)),
    };
  });

  const leagueCap = leagueSlotCapacity(rosterSlots, numTeams);
  const remainingSlotsLeague =
    v2Meta.remaining_slots ?? Math.max(0, leagueCap - draftedPlayers.length);
  const draftPhase = resolveDraftPhase({
    rosterSlots,
    numTeams,
    remainingSlotsLeague,
    draftedCount: draftedPlayers.length,
  });

  const baselineOrderForDepth = [...byValueRows].sort(
    (a, b) => (b.value || 0) - (a.value || 0)
  );
  const depthFracById = new Map<string, number>();
  const depthN = baselineOrderForDepth.length;
  baselineOrderForDepth.forEach((p, i) => {
    depthFracById.set(getPlayerId(p), depthN > 1 ? i / (depthN - 1) : 0);
  });

  const rosterDemandMap = buildLeagueSlotDemand(rosterSlots, numTeams);
  const rosterSlotKeysForFit = new Set(rosterDemandMap.keys());
  const replForTeam: Record<string, number> =
    inflationModelEffective === "replacement_slots_v2" && v2Result
      ? v2Result.replacement_values_by_slot_or_position
      : {};
  const byRowPlayerId = new Map(byValueRows.map((p) => [getPlayerId(p), p]));

  for (const row of valuations) {
    const depthFrac = depthFracById.get(row.player_id) ?? 0.5;
    const clearing = computeRecommendedBid({
      row,
      draftPhase,
      depthFrac,
      inflationIndexVsOpeningAuction,
    });
    row.recommended_bid = parseFloat(clearing.toFixed(2));
    if (options?.debugSignals) {
      const lp = byRowPlayerId.get(row.player_id);
      const tokens = lp ? playerTokensFromLean(lp) : [];
      const replBest = bestReplacementForPlayer(
        tokens,
        replForTeam,
        rosterSlotKeysForFit
      );
      const sb =
        inflationModelEffective === "replacement_slots_v2" && v2Result
          ? v2Result.playerIdToSurplusBasis.get(row.player_id) ?? 0
          : undefined;
      row.debug_v2 = {
        ...(row.debug_v2 ?? {}),
        lambda_used: Number(lambdaClearingPrice(draftPhase, depthFrac).toFixed(4)),
        surplus_basis:
          sb != null && Number.isFinite(sb) ? Number(sb.toFixed(4)) : undefined,
        replacement_key_used: replBest?.key ?? null,
        replacement_value_used:
          replBest?.value != null ? Number(replBest.value.toFixed(4)) : null,
      };
    }
  }

  smoothRecommendedBids(valuations);

  const symmetricOpenLeague = isSymmetricOpenLeagueContext({
    numTeams,
    draftedPlayers,
    additionalDraftedIds: options?.additionalDraftedIds ?? [],
    budgetByTeamId: options?.budgetByTeamId,
    rosteredPlayersForSlots: options?.rosteredPlayersForSlots,
  });

  const userTeamId = options?.userTeamId?.trim() || DEFAULT_USER_TEAM_ID;
  const openSlots = buildOpenSlotsForUserTeam(
    rosterSlots,
    options?.rosteredPlayersForSlots,
    userTeamId
  );
  const budgetMult = budgetPressureMultiplier(
    draftedPlayers,
    totalBudgetPerTeam,
    numTeams,
    options?.budgetByTeamId,
    userTeamId,
    budgetRemaining
  );
  const userRemaining = userBudgetRemaining(
    draftedPlayers,
    totalBudgetPerTeam,
    options?.budgetByTeamId,
    userTeamId
  );
  const openSeatTotal = [...openSlots.values()].reduce((s, v) => s + v, 0);
  const userCap = userTeamStartingSlots(rosterSlots);
  const slotFillRatio =
    userCap > 0 ? Math.max(0, Math.min(1, openSeatTotal / userCap)) : 1;
  const slotScarcityMult = 1 + 0.22 * (1 - slotFillRatio);
  const dpsRatio = dollarsPerSlotPeerRatio({
    userRemaining,
    openSeatTotal,
    budgetRemainingLeague: budgetRemaining,
    numTeams,
    remainingSlotsLeague: Math.max(1, remainingSlotsLeague),
  });
  let dpsMult = 1;
  if (dpsRatio > 1.18) {
    dpsMult += 0.14 * Math.min(2.2, dpsRatio - 1.18);
  } else if (dpsRatio < 0.82) {
    dpsMult -= 0.11 * Math.min(1.2, 0.82 - dpsRatio);
  }

  for (const row of valuations) {
    const lp = byRowPlayerId.get(row.player_id);
    if (!lp) continue;
    if (symmetricOpenLeague) {
      row.team_adjusted_value = parseFloat(row.adjusted_value.toFixed(2));
      if (options?.debugSignals) {
        row.debug_v2 = {
          ...(row.debug_v2 ?? {}),
          team_multipliers: {
            symmetric_open_collapsed: 1,
          },
        };
      }
      continue;
    }
    row.team_adjusted_value = computeTeamAdjustedValue({
      row,
      lp,
      openSlots,
      budgetMult,
      dpsMult,
      slotScarcityMult,
      replForTeam,
      rosterSlotKeysForFit,
    });
    if (options?.debugSignals) {
      const needMult = positionalNeedMultiplier(lp, openSlots);
      const tokens = playerTokensFromLean(lp);
      const drop = maxReplacementDropoff(
        row.baseline_value,
        tokens,
        replForTeam,
        rosterSlotKeysForFit
      );
      const dropMult =
        Object.keys(replForTeam).length > 0
          ? 1 + 0.22 * Math.min(1.25, drop / Math.max(8, row.baseline_value))
          : 1;
      row.debug_v2 = {
        ...(row.debug_v2 ?? {}),
        team_multipliers: {
          need: Number(needMult.toFixed(4)),
          budget: Number(budgetMult.toFixed(4)),
          dollars_per_slot: Number(dpsMult.toFixed(4)),
          slot_scarcity: Number(slotScarcityMult.toFixed(4)),
          replacement_dropoff: Number(dropMult.toFixed(4)),
        },
      };
    }
  }

  for (const row of valuations) {
    const rb = row.recommended_bid ?? MIN_AUCTION_BID;
    const ta = row.team_adjusted_value ?? row.adjusted_value;
    row.edge = parseFloat((ta - rb).toFixed(2));
  }

  const slotMeta: Partial<ValuationResponse> = {
    ...v2Meta,
    ...(v2Meta.remaining_slots == null
      ? { remaining_slots: Math.max(0, leagueCap - draftedPlayers.length) }
      : {}),
  };

  const calculatedAt = options?.deterministic
    ? DETERMINISTIC_CALCULATED_AT
    : new Date().toISOString();

  return {
    engine_contract_version: ENGINE_CONTRACT_VERSION,
    inflation_model: inflationModelEffective,
    inflation_factor: parseFloat(inflationFactor.toFixed(4)),
    ...(inflationIndexVsOpeningAuction != null
      ? { inflation_index_vs_opening_auction: inflationIndexVsOpeningAuction }
      : {}),
    inflation_raw: parseFloat(inflationRaw.toFixed(6)),
    inflation_bounded_by: inflationBoundedBy,
    total_budget_remaining: budgetRemaining,
    pool_value_remaining: parseFloat(poolValueRemaining.toFixed(2)),
    players_remaining: undraftedFull.length,
    valuations,
    recommended_bid_note: RECOMMENDED_BID_NOTE,
    user_team_id_used: userTeamId,
    team_adjusted_value_note: TEAM_ADJUSTED_NOTE,
    phase_indicator: draftPhase,
    calculated_at: calculatedAt,
    valuation_model_version: getValuationModelVersion(),
    ...slotMeta,
  };
}
