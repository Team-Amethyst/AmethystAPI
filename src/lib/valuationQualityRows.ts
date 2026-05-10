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
  if (!isFiniteNumber(row.auction_value)) {
    out.push(`${p}.auction_value must be a finite number`);
  } else if (row.auction_value < 0) {
    out.push(`${p}.auction_value should not be negative (reasonable prices)`);
  } else if (
    Math.abs(row.auction_value - row.adjusted_value) > 0.02
  ) {
    out.push(`${p}.auction_value must equal adjusted_value (canonical alias)`);
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
  if (!isFiniteNumber(row.catalog_rank) || row.catalog_rank < 0) {
    out.push(`${p}.catalog_rank must be a finite non-negative number`);
  }
  if (
    !Number.isInteger(row.catalog_tier) ||
    row.catalog_tier < 0 ||
    !Number.isFinite(row.catalog_tier)
  ) {
    out.push(`${p}.catalog_tier must be a non-negative integer`);
  }
  if (!Number.isInteger(row.baseline_rank) || row.baseline_rank < 1 || !Number.isFinite(row.baseline_rank)) {
    out.push(`${p}.baseline_rank must be a positive integer`);
  }
  if (!Number.isInteger(row.auction_rank) || row.auction_rank < 1 || !Number.isFinite(row.auction_rank)) {
    out.push(`${p}.auction_rank must be a positive integer`);
  }
  if (
    !Number.isInteger(row.baseline_tier) ||
    row.baseline_tier < 1 ||
    row.baseline_tier > 5
  ) {
    out.push(`${p}.baseline_tier must be an integer from 1 to 5`);
  }
  if (
    !Number.isInteger(row.auction_tier) ||
    row.auction_tier < 1 ||
    row.auction_tier > 5
  ) {
    out.push(`${p}.auction_tier must be an integer from 1 to 5`);
  }
  if (row.market_adp !== undefined && row.market_adp !== null) {
    if (!isFiniteNumber(row.market_adp) || row.market_adp <= 0) {
      out.push(`${p}.market_adp must be a positive finite number when set`);
    }
  }
  if (row.market_adp_source !== undefined && row.market_adp_source !== null) {
    if (typeof row.market_adp_source !== "string" || row.market_adp_source.trim() === "") {
      out.push(`${p}.market_adp_source must be a non-empty string when set`);
    }
  }
  if (row.market_adp_updated_at !== undefined && row.market_adp_updated_at !== null) {
    if (typeof row.market_adp_updated_at !== "string" || row.market_adp_updated_at.trim() === "") {
      out.push(`${p}.market_adp_updated_at must be a non-empty string when set`);
    }
  }
  if (row.market_adp_min !== undefined && row.market_adp_min !== null) {
    if (!isFiniteNumber(row.market_adp_min)) {
      out.push(`${p}.market_adp_min must be a finite number when set`);
    }
  }
  if (row.market_adp_max !== undefined && row.market_adp_max !== null) {
    if (!isFiniteNumber(row.market_adp_max)) {
      out.push(`${p}.market_adp_max must be a finite number when set`);
    }
  }
  if (row.market_pick_count !== undefined && row.market_pick_count !== null) {
    if (
      !Number.isInteger(row.market_pick_count) ||
      row.market_pick_count < 0 ||
      !Number.isFinite(row.market_pick_count)
    ) {
      out.push(`${p}.market_pick_count must be a non-negative integer when set`);
    }
  }
  return out;
}
