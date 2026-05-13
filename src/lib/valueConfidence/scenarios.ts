import type { DraftedPlayer, LeagueScope, LeanPlayer, NormalizedValuationInput } from "../../types/brain";
import {
  buildDraftroomStandardValuationInput,
  CALIBRATION_CATS_5X5,
  CALIBRATION_CATS_5X5_PLUS_HLD,
  CALIBRATION_CATS_QS_REPLACES_W,
  CALIBRATION_CATS_SAVES_ONLY,
  draftroomUiDefaultRoster,
  legacyEngineCalibrationRoster,
} from "../calibrationDraftroomFixture";
import { getPlayerId } from "../playerId";

export type ValueConfidenceScenario = {
  id: string;
  description: string;
  input: NormalizedValuationInput;
};

function base(): NormalizedValuationInput {
  return buildDraftroomStandardValuationInput({
    deterministic: true,
    seed: 42,
    explain_valuation_rows: true,
  });
}

function rosterNoCiMi(): NormalizedValuationInput["roster_slots"] {
  return draftroomUiDefaultRoster().filter((s) => s.position !== "CI" && s.position !== "MI");
}

function rosterFiveOf(): NormalizedValuationInput["roster_slots"] {
  return draftroomUiDefaultRoster().map((s) => (s.position === "OF" ? { ...s, count: 5 } : s));
}

function rosterTwoC(): NormalizedValuationInput["roster_slots"] {
  return draftroomUiDefaultRoster().map((s) => (s.position === "C" ? { ...s, count: 2 } : s));
}

/** First `n` picks by catalog `value` desc, snake-ish paid amounts for spend realism. */
export function buildDraftedPicks(
  pool: LeanPlayer[],
  n: number,
  numTeams: number,
  opts?: { keeperPickIndexes?: number[] }
): DraftedPlayer[] {
  const sorted = [...pool].filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  const keepers = new Set(opts?.keeperPickIndexes ?? []);
  const out: DraftedPlayer[] = [];
  for (let i = 0; i < Math.min(n, sorted.length); i++) {
    const p = sorted[i]!;
    const teamIdx = i % numTeams;
    const tid = `team_${teamIdx}`;
    const basePaid = 8 + ((i * 17) % 55);
    const isK = keepers.has(i);
    out.push({
      player_id: getPlayerId(p),
      name: p.name,
      position: p.position,
      team: p.team,
      team_id: tid,
      paid: isK ? Math.max(1, Math.round(basePaid * 0.35)) : basePaid,
      pick_number: i + 1,
      is_keeper: isK,
      keeper_cost: isK ? Math.max(1, Math.round(basePaid * 0.25)) : undefined,
    });
  }
  return out;
}

export function thinEligibleSubset(pool: LeanPlayer[], take: number): string[] {
  const sorted = [...pool].sort((a, b) => (a.catalog_rank ?? 9999) - (b.catalog_rank ?? 9999));
  const mid = Math.max(0, Math.floor(sorted.length / 3));
  const slice = sorted.slice(mid, mid + take);
  return slice.map((p) => getPlayerId(p));
}

export function topValuePlayerIds(pool: LeanPlayer[], n: number): string[] {
  return [...pool]
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
    .map((p) => getPlayerId(p));
}

export function buildValueConfidenceScenarios(pool: LeanPlayer[]): ValueConfidenceScenario[] {
  const b = base();
  const scenarios: ValueConfidenceScenario[] = [];

  const scopes: LeagueScope[] = ["Mixed", "AL", "NL"];
  const depths = [10, 12, 15] as const;
  for (const league_scope of scopes) {
    for (const num_teams of depths) {
      scenarios.push({
        id: `vc_${league_scope}_t${num_teams}_avg_clean`,
        description: `${league_scope} ${num_teams}-team, AVG 5×5, clean draft`,
        input: { ...b, league_scope, num_teams, drafted_players: [] },
      });
    }
  }

  scenarios.push(
    {
      id: "vc_mixed_t12_roster_2c",
      description: "Mixed 12, 2× C",
      input: { ...b, roster_slots: rosterTwoC() },
    },
    {
      id: "vc_mixed_t12_roster_5of",
      description: "Mixed 12, 5× OF",
      input: { ...b, roster_slots: rosterFiveOf() },
    },
    {
      id: "vc_mixed_t12_roster_no_ci_mi",
      description: "Mixed 12, no CI/MI",
      input: { ...b, roster_slots: rosterNoCiMi() },
    },
    {
      id: "vc_mixed_t12_roster_legacy_p",
      description: "Mixed 12, legacy generic P roster",
      input: { ...b, roster_slots: legacyEngineCalibrationRoster() },
    }
  );

  scenarios.push(
    {
      id: "vc_mixed_t12_bat_obp",
      description: "OBP replaces AVG",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "AVG" ? { name: "OBP", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "vc_mixed_t12_bat_slg",
      description: "SLG replaces AVG",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "AVG" ? { name: "SLG", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "vc_mixed_t12_bat_ops",
      description: "OPS replaces AVG",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "AVG" ? { name: "OPS", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "vc_mixed_t12_bat_tb",
      description: "TB replaces RBI",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "RBI" ? { name: "TB", type: "batting" as const } : c
        ),
      },
    },
    {
      id: "vc_mixed_t12_pitch_sv_only_style",
      description: "Saves-only style pitching (no W)",
      input: { ...b, scoring_categories: CALIBRATION_CATS_SAVES_ONLY },
    },
    {
      id: "vc_mixed_t12_pitch_hld_addon",
      description: "5×5 + HLD",
      input: { ...b, scoring_categories: CALIBRATION_CATS_5X5_PLUS_HLD },
    },
    {
      id: "vc_mixed_t12_pitch_sv_hld",
      description: "SV+HLD combined label",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "SV" ? { name: "SV+HLD", type: "pitching" as const } : c
        ),
      },
    },
    {
      id: "vc_mixed_t12_pitch_k9",
      description: "K/9 replaces K",
      input: {
        ...b,
        scoring_categories: CALIBRATION_CATS_5X5.map((c) =>
          c.name === "K" ? { name: "K/9", type: "pitching" as const } : c
        ),
      },
    },
    {
      id: "vc_mixed_t12_pitch_qs",
      description: "QS replaces W",
      input: { ...b, scoring_categories: CALIBRATION_CATS_QS_REPLACES_W },
    }
  );

  for (const n of [25, 75, 150] as const) {
    scenarios.push({
      id: `vc_mixed_t12_draft_${n}`,
      description: `Mixed 12, ${n} picks drafted`,
      input: { ...b, drafted_players: buildDraftedPicks(pool, n, 12) },
    });
  }

  scenarios.push({
    id: "vc_mixed_t12_keeper_spread",
    description: "Mixed 12, 60 picks with keeper flags on scattered picks",
    input: {
      ...b,
      drafted_players: buildDraftedPicks(pool, 60, 12, {
        keeperPickIndexes: [5, 12, 24, 33, 41],
      }),
    },
  });

  scenarios.push({
    id: "vc_mixed_t12_thin_eligible",
    description: "Mixed 12, thin custom eligible universe",
    input: {
      ...b,
      eligible_player_ids: thinEligibleSubset(pool, Math.min(180, Math.max(80, Math.floor(pool.length * 0.35)))),
    },
  });

  scenarios.push({
    id: "vc_mixed_t12_excluded_elites",
    description: "Mixed 12, exclude top-12 catalog value IDs",
    input: {
      ...b,
      excluded_player_ids: topValuePlayerIds(pool, 12),
    },
  });

  scenarios.push({
    id: "vc_mixed_t12_unsupported_category_probe",
    description: "Unsupported category should emit response warning (non-strict)",
    input: {
      ...b,
      scoring_categories: [
        ...CALIBRATION_CATS_5X5,
        { name: "ZZZ_UNSUPPORTED_FAKE", type: "batting" },
      ],
    },
  });

  return scenarios;
}
