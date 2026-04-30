import type { SignalSeverity, SignalType } from "./core";

export interface NewsSignal {
  player_id?: string;
  player_name: string;
  signal_type: SignalType;
  severity: SignalSeverity;
  description: string;
  effective_date: string;
  source: string;
}

export interface SignalsResponse {
  signals: NewsSignal[];
  fetched_at: string;
  count: number;
}
