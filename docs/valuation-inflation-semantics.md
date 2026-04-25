# Valuation inflation semantics (Engine)

This document is the **contract** for how `POST /valuation/calculate` and `POST /valuation/player` turn league settings + draft state into **dollar targets** (`adjusted_value`).

Select the pass with **`inflation_model`** (request; defaults to **`global_v1`**):

- **`global_v1`** — Simple league-wide rescale: stable and rank-preserving on the full wire, but it can produce odd auction targets because it prices **every** undrafted player in the denominator.
- **`surplus_slots_v1`** — Roster-constrained surplus model with **one** league-wide replacement cutoff: reserves **$1** per **remaining empty roster slot**, builds a **draftable slice** from the top of the undrafted list, and maps **surplus cash** onto **value above replacement**. Useful for comparison; weaker than v2 when positions differ.
- **`replacement_slots_v2`** — **Draftroom-preferred** slot/position-aware model: builds **per-slot replacement** levels from a deterministic greedy league-wide assignment (rostered players first, then undrafted by baseline), supports **CI / MI / UTIL / P / SP / RP / BN**, reserves **$1** per remaining slot, and maps **surplus cash** onto **max surplus over eligible slots** for each player. **Never** falls back to `global_v1`; degenerate cases use **`fallback_reason`** and baseline-safe or **min_bid** pricing (see response metadata).

## Shared definitions

### Undrafted pool (valuation basis)

- Start from catalog players in **`league_scope`**.
- Remove every player whose **`player_id`** appears as drafted (auction `drafted_players` / `draft_state`) or in keeper/minors/taxi off-board ids from the workflow.
- **`player_ids` does not shrink this set** for inflation. It only limits **which rows appear** in `valuations[]` (payload filter / perf).

### Budget

Unchanged: either **`budget_by_team_id`** sum or `total_budget × num_teams − Σ paid − keeper/minor spend` per existing rules.

### Remaining roster slots (for `surplus_slots_v1` and metadata in `replacement_slots_v2`)

Derived in the engine (no explicit slot counts from Draft):

- **`slots_per_team`** = Σ `roster_slots[].count`
- **`capacity`** = `slots_per_team × num_teams`
- **`filled`** = unique `player_id` in **`drafted_players`** ∪ ids from **`pre_draft_rosters`**, **`minors`**, and **`taxi`** (same off-board set used to remove players from the undrafted pool)
- **`remaining_slots`** = `max(0, capacity − filled.size)`

### Steal / Reach

Value and ADP ranks are computed on the **full** undrafted pool so indicators stay meaningful when `valuations[]` lists only a subset.

---

## `global_v1`

### Pool aggregates

- **`pool_value_remaining`** = sum of baseline **`value`** over the **full** undrafted pool (inflation denominator).
- **`players_remaining`** = count of players in that **full** undrafted pool.

### Inflation factor

1. **`inflation_raw`** = `total_budget_remaining / pool_value_remaining` (or `1` if pool value is 0).
2. **`inflation_factor`** (applied) = clamp **`inflation_raw`** to workflow **cap** and **floor** (retry passes may vary cap/floor).

### Per row

- **`baseline_value`** — output of `scoringAwareBaselinePlayers`.
- **`adjusted_value`** = `baseline_value × inflation_factor` (same factor for every returned row).

---

## `surplus_slots_v1`

If the surplus plan is **degenerate** (e.g. `remaining_slots === 0`, empty undrafted pool, or **zero** surplus mass in the draftable slice), the engine **falls back** to **`global_v1` math** and returns **`inflation_model: "global_v1"`** so clients always get valid numbers.

Otherwise **`inflation_model: "surplus_slots_v1"`**.

### Draftable slice

- **`K`** = `min(undrafted_count, ceil(remaining_slots × 1.35))` (multiplier overridable in code via `surplusDraftablePoolMultiplier` for tests).
- Sort undrafted players by **baseline value descending** (same deterministic tie-breaks as global).
- **`draftable_pool`** = top **`K`** players.
- **`replacement_value`** = baseline value of the **lowest** player in `draftable_pool` (slice floor).

### Surplus cash and denominator

- **`min_bid`** = **1** (auction unit; same as dollar when budget is in dollars).
- **`surplus_cash`** = `max(0, total_budget_remaining − remaining_slots × min_bid)`
- **`pool_value_remaining`** = Σ **`max(0, baseline_value − replacement_value)`** over **`draftable_pool`** only (this is the inflation **denominator**, not full-wire list dollars).
- **`inflation_raw`** = `surplus_cash / pool_value_remaining` (or `1` if denominator is 0 — should not occur when surplus mode is active).
- **`inflation_factor`** = clamp **`inflation_raw`** to workflow cap/floor (same mechanism as global).

### Per row (all undrafted players, not only the slice)

For every undrafted player in returned rows:

- **`surplus_value`** = `max(0, baseline_value − replacement_value)`
- **`adjusted_value`** = `min_bid + inflation_factor × surplus_value`

So players at or below **replacement** in model dollars stay near **$1**; stars absorb **surplus cash**. **`players_remaining`** is still the **full** undrafted count.

---

## `replacement_slots_v2`

### Slot demand

- For each `roster_slots` row, **`demand[slot] += count × num_teams`** where `slot` is the uppercase roster label (`C`, `1B`, …, `UTIL`, `P`, …).

### Roster consumption (greedy, deterministic)

1. Build **`rosteredPlayersForSlotEngine`**: unique `player_id` from **`drafted_players`** plus keepers/minors/taxi rows (auction rows win on duplicate ids). Baselines come from the scoped catalog (`value` after the baseline engine).
2. Sort rostered candidates by **baseline descending** (seeded tie-break when `deterministic`).
3. **Greedy assign** each rostered player to an open slot they **fit** (see `src/lib/fantasyRosterSlots.ts`): maximize **`baseline − min(assigned baselines at that slot)`** with empty slot floor **0**; ties → **more specific** slot first (`SLOT_SPECIFICITY_ORDER`). If nothing fits, force **BN** when BN demand exists.
4. Repeat greedy assignment for **undrafted** players (same sort) until **all slot demand is 0** or the undrafted list is exhausted. Track which undrafted ids received a slot → **`draftable_pool_size`** and **`total_surplus_mass`**.

### Eligibility (high level)

- **CI**: `1B` or `3B` tokens; **MI**: `2B` or `SS`; **P**: `SP` or `RP`; **UTIL**: **hitters only** (no SP-only pitcher on UTIL); **BN**: anyone.

### Replacement and surplus

- After the fill, **`replacement_values_by_slot_or_position[slot]`** = **minimum** baseline among players assigned to that slot (worst “starter” at that bucket), or **0** if none.
- For each undrafted player, **`surplus_basis`** = **`max(0, max_{eligible slot s}(baseline − repl[s]))`**.
- **`remaining_slots`** in the response = **Σ remaining slot demand after rostered consumption** (before undrafted fill).
- **`surplus_cash`** = `max(0, total_budget_remaining − remaining_slots × min_bid)` with **`min_bid = 1`**.
- **`total_surplus_mass`** = Σ **`surplus_basis`** over undrafted players who **received** a slot in the undrafted greedy pass (the marginal draft economy).
- **`pool_value_remaining`** = **`total_surplus_mass`** (denominator for `inflation_raw` when positive).
- **`inflation_raw`** = `surplus_cash / total_surplus_mass` when both are positive; workflow **cap/floor** applies unless the engine marks a **terminal** path (**`skip`** clamp for `no_remaining_slots`, `no_surplus_cash`, `no_surplus_mass`, `no_undrafted_players`).

### Per row

- **`adjusted_value`** = **`baseline`** when **`fallback_reason === "no_remaining_slots"`**.
- When **`no_surplus_mass`** with **`surplus_cash > 0`**: **`adjusted_value = max(min_bid, baseline)`** (baseline-safe).
- Otherwise: **`min_bid + inflation_factor × surplus_basis`**.
- When **`no_surplus_cash`**: **`inflation_factor = 0`** so prices sit at **`min_bid`** for marginal surplus.

### Response metadata (always for v2)

`remaining_slots`, `min_bid`, `surplus_cash`, `total_surplus_mass`, `draftable_pool_size`, `replacement_values_by_slot_or_position`, `fallback_reason`.

---

## Bounded-by flag

- **`inflation_bounded_by: "none"`** — applied equals raw (within float tolerance).
- **`"cap"`** — raw exceeded cap; applied is capped.
- **`"floor"`** — raw fell below floor (after cap step); applied is floored.

## Consumers (AmethystDraft)

- Echo **`inflation_model`** on responses; interpret **`inflation_raw`** and **`pool_value_remaining`** using the active model (see above).
- **`pool_value_remaining` / `players_remaining`** are **not** “rows returned.” Row count is `valuations.length`.
