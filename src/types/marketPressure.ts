export type MarketInflationStatus =
  | "not_started"
  | "low_sample"
  | "inflated"
  | "neutral"
  | "deflated";

export type MarketInflationConfidence = "none" | "low" | "medium" | "high";

export type BudgetPressureStatus = "tight" | "balanced" | "loose";

export type KeeperCompressionStatus = "none" | "low" | "moderate" | "high";

export type MarketInflationPressure = {
  status: MarketInflationStatus;
  ratio: number | null;
  percent: number | null;
  sample_size: number;
  actual_spend: number;
  expected_spend: number;
  confidence: MarketInflationConfidence;
  label: string;
  explanation: string;
};

export type BudgetPressureSnapshot = {
  status: BudgetPressureStatus;
  total_budget_remaining: number;
  remaining_active_slots: number;
  min_bid_reserve: number;
  surplus_cash: number;
  total_surplus_mass: number | null;
  cash_to_surplus_mass_ratio: number | null;
  dollars_per_open_slot: number | null;
  label: string;
  explanation: string;
};

export type KeeperCompressionSnapshot = {
  status: KeeperCompressionStatus;
  active_keeper_count: number;
  active_capacity: number;
  keeper_slot_fill_ratio: number;
  keeper_salary_committed: number;
  total_league_budget: number;
  keeper_budget_share: number;
  label: string;
  explanation: string;
};

export type AllocatorVsOpenSnapshot = {
  ratio: number | null;
  percent: number | null;
  label: string;
  explanation: string;
};

export type MarketPressureSnapshot = {
  market_inflation: MarketInflationPressure;
  budget_pressure: BudgetPressureSnapshot;
  keeper_compression: KeeperCompressionSnapshot;
  allocator_vs_open: AllocatorVsOpenSnapshot;
};
