# Valuation inflation semantics (Engine v1)

This document is the **contract** for how `POST /valuation/calculate` and `POST /valuation/player` turn league settings + draft state into **dollar targets** (`adjusted_value`).

## Core feature

**Current player value in the league** = baseline list dollars for that player in this scoring/roster context, scaled by a **single league-wide inflation factor** so that remaining auction budget maps onto the **full** remaining undrafted talent pool.

## Definitions

### Undrafted pool (inflation basis)

- Start from catalog players in **`league_scope`**.
- Remove every player whose **`player_id`** appears as drafted (auction `drafted_players` / `draft_state`) or in keeper/minors/taxi off-board ids from the workflow.
- **`player_ids` does not shrink this set** for inflation. It only limits **which rows appear** in `valuations[]` (payload filter / perf).

So:

- **`pool_value_remaining`** = sum of baseline **`value`** over that **full** undrafted pool (same pool used in the inflation denominator).
- **`players_remaining`** = count of players in that **full** undrafted pool.

### Budget

Unchanged: either **`budget_by_team_id`** sum or `total_budget × num_teams − Σ paid − keeper/minor spend` per existing rules.

### Inflation factor

1. **`inflation_raw`** = `total_budget_remaining / pool_value_remaining` (or `1` if pool value is 0).
2. **`inflation_factor`** (applied) = clamp **`inflation_raw`** to workflow **cap** and **floor** (retry passes may vary cap/floor).

### Bounded-by flag

- **`inflation_bounded_by: "none"`** — applied equals raw (within float tolerance).
- **`"cap"`** — raw exceeded cap; applied is capped.
- **`"floor"`** — raw fell below floor (after cap step); applied is floored.

### Per row

- **`baseline_value`** — output of `scoringAwareBaselinePlayers` (not raw Mongo `value` alone).
- **`adjusted_value`** = `baseline_value × inflation_factor` (same factor for every returned row).

### Steal / Reach

Value and ADP ranks are computed on the **full** undrafted pool so indicators stay meaningful when `valuations[]` lists only a subset.

## Rationale

If `player_ids` filtered the pool used for inflation, **one player + full league budget** would imply absurd raw inflation and permanent **cap** hits (`POST /valuation/player`). That contradicted “value in this draft.” Separating **inflation basis** from **response filter** fixes that without changing Draft’s wire shape beyond clearer aggregate semantics.

## Consumers (AmethystDraft)

- **`pool_value_remaining` / `players_remaining`** now always describe the **inflation basis pool**, not “rows returned.” Row count is `valuations.length`.
- Optional additive fields: **`inflation_raw`**, **`inflation_bounded_by`** — use in UI when explaining “hot market” vs “model clamp active.”
