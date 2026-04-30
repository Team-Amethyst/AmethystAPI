import type { ValuedPlayer } from "../types/brain";
import { INDICATORS, isFiniteNumber } from "./valuationQualityConstants";

export function rowIssues(row: ValuedPlayer, index: number): string[] {
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
    } else if (row.recommended_bid < 1) {
      out.push(`${p}.recommended_bid must be >= 1 (min bid)`);
    } else if (row.recommended_bid > 20000) {
      out.push(`${p}.recommended_bid exceeds sanity ceiling`);
    }
  }
  if (row.team_adjusted_value != null) {
    if (!isFiniteNumber(row.team_adjusted_value)) {
      out.push(`${p}.team_adjusted_value must be a finite number when present`);
    } else if (row.team_adjusted_value < 0) {
      out.push(`${p}.team_adjusted_value should not be negative`);
    } else if (row.team_adjusted_value > 25000) {
      out.push(`${p}.team_adjusted_value exceeds sanity ceiling`);
    }
  }
  if (row.edge != null) {
    if (!isFiniteNumber(row.edge)) {
      out.push(`${p}.edge must be a finite number when present`);
    } else if (
      row.team_adjusted_value != null &&
      row.recommended_bid != null &&
      Math.abs(
        row.edge -
          ((row.team_adjusted_value as number) - (row.recommended_bid as number))
      ) > 0.02
    ) {
      out.push(
        `${p}.edge must equal team_adjusted_value − recommended_bid (within rounding)`
      );
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
