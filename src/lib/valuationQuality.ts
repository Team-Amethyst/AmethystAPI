import { ENGINE_CONTRACT_VERSION } from "./engineContract";
import type { ValuationResponse, ValuedPlayer, ValueIndicator } from "../types/brain";

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

  if (!isFiniteNumber(response.inflation_factor)) {
    issues.push("inflation_factor must be a finite number");
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

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true };
}
