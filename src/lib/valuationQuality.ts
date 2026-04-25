import { ENGINE_CONTRACT_VERSION } from "./engineContract";
import type {
  InflationBoundedBy,
  InflationModel,
  ValuationResponse,
  ValuedPlayer,
  ValueIndicator,
} from "../types/brain";

const BOUNDED: Set<InflationBoundedBy> = new Set(["none", "cap", "floor"]);

const INFLATION_MODELS: Set<InflationModel> = new Set([
  "global_v1",
  "surplus_slots_v1",
  "replacement_slots_v2",
]);

const INDICATORS: Set<ValueIndicator> = new Set([
  "Steal",
  "Reach",
  "Fair Value",
]);

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function rowIssues(row: ValuedPlayer, index: number): string[] {
  const p = `valuations.${index}`;
  const out: string[] = [];
  if (typeof row.player_id !== "string" || row.player_id.length === 0) {
    out.push(`${p}.player_id must be a non-empty string`);
  }
  if (!isFiniteNumber(row.baseline_value)) {
    out.push(`${p}.baseline_value must be a finite number`);
  } else if (row.baseline_value < 0) {
    out.push(`${p}.baseline_value should not be negative (reasonable prices)`);
  }
  if (!isFiniteNumber(row.adjusted_value)) {
    out.push(`${p}.adjusted_value must be a finite number`);
  } else if (row.adjusted_value < 0) {
    out.push(`${p}.adjusted_value should not be negative (reasonable prices)`);
  }
  if (row.recommended_bid != null) {
    if (!isFiniteNumber(row.recommended_bid)) {
      out.push(`${p}.recommended_bid must be a finite number when present`);
    } else {
      const lo = Math.min(row.adjusted_value, row.baseline_value);
      const hi = Math.max(row.adjusted_value, row.baseline_value);
      if (row.recommended_bid + 1e-9 < lo || row.recommended_bid - 1e-9 > hi) {
        out.push(
          `${p}.recommended_bid must be between adjusted_value and baseline_value`
        );
      }
    }
  }
  if (row.team_adjusted_value != null) {
    if (!isFiniteNumber(row.team_adjusted_value)) {
      out.push(`${p}.team_adjusted_value must be a finite number when present`);
    } else if (row.team_adjusted_value < 0) {
      out.push(`${p}.team_adjusted_value should not be negative`);
    } else {
      const cap = Math.max(0, row.baseline_value * 1.5);
      if (row.team_adjusted_value - cap > 1e-9) {
        out.push(`${p}.team_adjusted_value must be <= 1.5 × baseline_value`);
      }
    }
  }
  if (!isFiniteNumber(row.inflation_factor)) {
    out.push(`${p}.inflation_factor must be a finite number`);
  }
  if (!INDICATORS.has(row.indicator)) {
    out.push(`${p}.indicator must be Steal, Reach, or Fair Value`);
  }
  if (typeof row.name !== "string") {
    out.push(`${p}.name must be a string`);
  }
  return out;
}

/**
 * Post-condition checks after auction-dollar conversion (UML “Validate rankings
 * and price reasonableness”). Does not mutate; callers fail the HTTP request with
 * **422** when issues are non-empty so clients never rely on bad prices.
 */
export function validateValuationResponse(
  response: ValuationResponse
): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];

  if (
    typeof response.engine_contract_version !== "string" ||
    response.engine_contract_version !== ENGINE_CONTRACT_VERSION
  ) {
    issues.push(
      `engine_contract_version must be "${ENGINE_CONTRACT_VERSION}"`
    );
  }

  if (!INFLATION_MODELS.has(response.inflation_model)) {
    issues.push(
      "inflation_model must be global_v1, surplus_slots_v1, or replacement_slots_v2"
    );
  }

  if (response.inflation_model === "replacement_slots_v2") {
    const checkOptInt = (label: string, v: unknown) => {
      if (v === undefined) return;
      if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < 0 ||
        !Number.isFinite(v)
      ) {
        issues.push(`${label} must be a non-negative integer when present`);
      }
    };
    checkOptInt("remaining_slots", response.remaining_slots);
    checkOptInt("draftable_pool_size", response.draftable_pool_size);
    if (response.min_bid !== undefined) {
      if (!isFiniteNumber(response.min_bid) || response.min_bid < 0) {
        issues.push("min_bid must be a finite non-negative number when present");
      }
    }
    if (
      response.surplus_cash !== undefined &&
      (!isFiniteNumber(response.surplus_cash) || response.surplus_cash < 0)
    ) {
      issues.push("surplus_cash must be a finite non-negative number when present");
    }
    if (
      response.total_surplus_mass !== undefined &&
      (!isFiniteNumber(response.total_surplus_mass) ||
        response.total_surplus_mass < 0)
    ) {
      issues.push(
        "total_surplus_mass must be a finite non-negative number when present"
      );
    }
    const rep = response.replacement_values_by_slot_or_position;
    if (rep !== undefined) {
      if (typeof rep !== "object" || rep === null || Array.isArray(rep)) {
        issues.push(
          "replacement_values_by_slot_or_position must be an object when present"
        );
      } else {
        for (const [k, val] of Object.entries(rep)) {
          if (
            typeof k !== "string" ||
            !isFiniteNumber(val) ||
            (val as number) < 0
          ) {
            issues.push(
              "replacement_values_by_slot_or_position entries must be non-negative numbers"
            );
            break;
          }
        }
      }
    }
    if (
      response.fallback_reason != null &&
      typeof response.fallback_reason !== "string"
    ) {
      issues.push("fallback_reason must be a string or null when present");
    }
  }

  if (!isFiniteNumber(response.inflation_factor)) {
    issues.push("inflation_factor must be a finite number");
  }
  if (!isFiniteNumber(response.inflation_raw)) {
    issues.push("inflation_raw must be a finite number");
  }
  if (!BOUNDED.has(response.inflation_bounded_by)) {
    issues.push("inflation_bounded_by must be none, cap, or floor");
  }
  if (!isFiniteNumber(response.total_budget_remaining)) {
    issues.push("total_budget_remaining must be a finite number");
  } else if (response.total_budget_remaining < 0) {
    issues.push("total_budget_remaining should not be negative");
  }
  if (!isFiniteNumber(response.pool_value_remaining)) {
    issues.push("pool_value_remaining must be a finite number");
  } else if (response.pool_value_remaining < 0) {
    issues.push("pool_value_remaining should not be negative");
  }
  if (
    typeof response.players_remaining !== "number" ||
    !Number.isInteger(response.players_remaining) ||
    response.players_remaining < 0
  ) {
    issues.push("players_remaining must be a non-negative integer");
  }
  if (typeof response.calculated_at !== "string" || response.calculated_at.length === 0) {
    issues.push("calculated_at must be a non-empty ISO timestamp string");
  }
  if (!Array.isArray(response.valuations)) {
    issues.push("valuations must be an array");
  } else {
    response.valuations.forEach((row, i) => {
      issues.push(...rowIssues(row, i));
    });
  }
  if (
    response.user_team_id_used != null &&
    (typeof response.user_team_id_used !== "string" ||
      response.user_team_id_used.length === 0)
  ) {
    issues.push("user_team_id_used must be a non-empty string when present");
  }
  if (
    response.team_adjusted_value_note != null &&
    typeof response.team_adjusted_value_note !== "string"
  ) {
    issues.push("team_adjusted_value_note must be a string when present");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true };
}
