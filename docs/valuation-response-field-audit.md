# Valuation API response fields — meaning, correctness, and follow-ups

This document tracks **code-path semantics** plus **`pnpm run audit:valuation-response`** (mock catalog + `test-fixtures/player-api/checkpoints/*.json`). Re-run after pricing or fixture changes.

---

## How a response is produced (pipeline)

1. **`parseValuationRequest`** — normalizes Draft/flat/nested bodies to `NormalizedValuationInput` (optional **`league_id`** or nested **`league.id`** for `context_v2`).
2. **`scoringAwareBaselinePlayers`** (`baselineValueEngine.ts`) — adjusts each catalog row’s **`value`** from Mongo using **`scoring_format`**, **`scoring_categories`**, **`roster_slots`** (projection stats when present, plus a scarcity multiplier). Stashes component hints on `projection.__valuation_meta__`.
3. **`calculateInflation`** (`inflationEngine.ts`) — removes drafted / off-board ids; **`inflation_model`** selects **`global_v1`**, **`surplus_slots_v1`**, or **`replacement_slots_v2`** (slot-aware greedy replacement + surplus; see `replacementSlotsV2.ts` + `fantasyRosterSlots.ts`). **`player_ids`** only filters **`valuations[]`**.
4. **Per row** — `adjusted_value` from the active model; Steal/Reach from **value rank vs ADP rank** on the **full** undrafted pool.
5. **`validateValuationResponse`** — structural / finiteness checks (not economic truth).
6. **`attachValuationExplainability`** — adds `market_notes`, `why`, `explain_v2`, `context_v2` using **`analyzeScarcity`** on the **same baseline-adjusted** catalog passed into attach (aligned with pricing pool).

---

## Top-level fields (`ValuationResponse`)

| Field | Intended meaning | Confidence / caveats |
|-------|-------------------|----------------------|
| **`engine_contract_version`** | Wire format / drift detector for Draft | **Reliable** — constant from `ENGINE_CONTRACT_VERSION`. |
| **`inflation_model`** | `global_v1`, `surplus_slots_v1`, or `replacement_slots_v2` | Echoes what math ran; v2 never falls back to global (uses `fallback_reason` instead). See [valuation-inflation-semantics.md](valuation-inflation-semantics.md). |
| **`inflation_factor`** | Applied multiplier after workflow cap/floor | Interpret with **`inflation_raw`** / **`inflation_bounded_by`** and **`inflation_model`**. On surplus, it scales **marginal list $** above replacement, not whole-list list $. |
| **`inflation_raw`** | Pre-clamp ratio (meaning depends on **`inflation_model`**) | **`global_v1`:** budget ÷ full undrafted pool $. **`surplus_slots_v1`:** surplus cash ÷ draftable surplus $. **`replacement_slots_v2`:** surplus cash ÷ `total_surplus_mass` (or `0` / `1` on terminal paths). |
| **`inflation_bounded_by`** | `none` / `cap` / `floor` | Which bound affected **`inflation_factor`** relative to **`inflation_raw`**. |
| **`total_budget_remaining`** | League dollars left | **Reliable** given request semantics: either **`budget_by_team_id`** sum or `total_budget * num_teams - Σ paid` (+ keeper spend rules from workflow). |
| **`pool_value_remaining`** | Inflation denominator for the active model | **`global_v1`:** Σ baseline on full undrafted pool. **`surplus_slots_v1`:** Σ `max(0, baseline − replacement)` on the draftable slice. **`replacement_slots_v2`:** `total_surplus_mass`. **Not** re-scaled when `player_ids` limits `valuations[]`. |
| **`players_remaining`** | Count of that **full** undrafted pool | **Not** `valuations.length` when `player_ids` is present. See [valuation-inflation-semantics.md](valuation-inflation-semantics.md). |
| **`calculated_at`** | Timestamp | **Reliable**; deterministic fixtures pin to epoch when `deterministic: true`. |
| **`valuation_model_version`** | Deploy / build label | **`VALUATION_MODEL_VERSION`** env, else **`GITHUB_SHA`** / **`GIT_COMMIT`**, else **`package.json`** `name@version`. Docker CI passes **`BUILD_GIT_SHA`**. |
| **`valuations[]`** | Per-player rows | See below. |
| **`market_notes`**, **`context_v2`** | Narrative + structured cards | **Heuristic UX** built from scarcity + inflation; see **Explainability** section. |

---

## Per-row fields (`ValuedPlayer`)

| Field | Intended meaning | Confidence / caveats |
|-------|-------------------|----------------------|
| **`player_id`, `name`, `position`, `team`, `adp`, `tier`** | Echo catalog identity / sort keys | **Reliable** from Mongo lean row (subject to sync quality). |
| **`baseline_value`** | List / “pre-auction” $ before **league** inflation | **Post-`scoringAwareBaselinePlayers`** — already includes **roster scarcity + projection bump** when those paths run. **Do not** read this as raw Mongo `value` unless you bypass baseline math. |
| **`adjusted_value`** | Auction target from active **`inflation_model`** | **`global_v1`:** `baseline × inflation_factor`. **`surplus_slots_v1`:** `min_bid + inflation_factor × max(0, baseline − replacement)`. **`replacement_slots_v2`:** see semantics doc (`no_remaining_slots` → baseline; `no_surplus_mass`+cash → `max(min_bid,baseline)`; else `min_bid + factor × slot-surplus_basis`). |
| **`remaining_slots`, `min_bid`, `surplus_cash`, `total_surplus_mass`, `draftable_pool_size`** | v2 economics | Present when **`inflation_model === "replacement_slots_v2"`**. |
| **`replacement_values_by_slot_or_position`** | v2 per-slot replacement baseline $ | Map keyed by roster slot label. |
| **`fallback_reason`** | v2 terminal path label | e.g. `no_surplus_cash`, `no_surplus_mass`, `no_remaining_slots`, `no_undrafted_players`, or `null`. |
| **`indicator`** (Steal / Reach / Fair Value) | ADP rank vs **baseline value** rank mismatch | **Internally consistent** with current definitions; **not** “vs industry ADP consensus” unless Mongo `adp` is that source. |
| **`inflation_factor` (row)** | Copy of league factor | **Redundant** with top-level; same value every row. |
| **`baseline_components`** | `projection_component`, `scarcity_component`, `scoring_format` | **Reliable** when `__valuation_meta__` is populated by baseline engine. With **empty projections** (common in tests / thin sync), **`projection_component` is often ~0** and scarcity still moves **`value`** — users may think “projection is broken” when it is “no stats row”. |
| **`scarcity_adjustment`** | Reserved wire field | **Always `0`**. Roster scarcity is **embedded in `baseline_value`**; use **`baseline_components.scarcity_component`** for the multiplier story. **`scarcity_adjustment + inflation_adjustment === adjusted_value - baseline_value`**. |
| **`inflation_adjustment`** | Full auction delta | **`adjusted_value - baseline_value`** (entire move from list to auction target from the league-wide factor). |
| **`why[]`** | Human bullets | Uses **`baseline_components`** for scarcity copy; inflation sentence stays accurate. |
| **`explain_v2`** | Structured drivers / confidence | **`adjustments`** reconcile to **`auction_target - list_value`**; drivers describe league factor vs embedded scarcity context. |

---

## `context_v2` and `market_notes`

- **`scope.league_id`** — from request **`league_id`** or nested **`league.id`**; otherwise **`"unknown"`**. Draft should send one of these for multi-tenant UIs.
- **`market_summary.headline`** — template from inflation % + top scarcity position. **Coherent** with `inflation_factor` and `analyzeScarcity` ordering.
- **`position_alerts`** — from **`analyzeScarcity`** on the **baseline-adjusted** pool; **aligned** with the same undrafted set used after drafted ids (not raw Mongo).
- **`assumptions` / `confidence`** — includes inflation clamp note and catalog-calibration pointer (fixture audit script).

---

## What we ran (`audit:valuation-response`)

- **Catalog:** 512 synthetic players (same shape as valuation integration mock).
- **Fixtures:** all `*.json` in `test-fixtures/player-api/checkpoints/`.
- **Observed:** `inflation_factor` pinned at **0.25** (workflow floor) with large **`pool_value_remaining`** vs **`total_budget_remaining`** — expected when list dollars exceed remaining cash.
- **Decomposition:** **`max |Δ − (scarcity_adj + infl_adj)|`** should be **~0** after **`scarcity_adjustment := 0`**.
- **Single-player slice:** HTTP `/valuation/player` merges the id into **`normalized.player_ids`**. **`executeValuationWorkflow` directly** needs **`input.player_ids`** to filter; **`scope.playerId`** alone does not shrink the pool.

---

## Operational QA (P3)

- **`pnpm run audit:valuation-response`** — fixture pass against mock catalog; catches shape regressions and decomposition drift.
- **`VALUATION_AGGREGATE_LOG=1`** — logs **`valuation_aggregate`** (inflation, pool $, budgets, `valuation_model_version`) per successful valuation for production sampling.

---

## Implemented recommendations (historical audit)

| Priority | Item | Status |
|----------|--------|--------|
| P0 | OpenAPI + types: honest **`baseline_value`**, **`scarcity_adjustment`**, **`inflation_adjustment`**, inflation clamp | **Done** (`openapi/openapi.yaml`, `src/types/brain.ts`). |
| P1 | **`valuation_model_version`** from env / git / package | **Done** (`src/lib/valuationModelVersion.ts`, Dockerfile **`BUILD_GIT_SHA`**, CI `docker build --build-arg`). |
| P1 | **`league_id`** / **`league.id`** → `context_v2` | **Done** (parse + schemas + ENGINE brief + README). |
| P2 | Additive decomposition | **Done** — **`scarcity_adjustment = 0`**, narrative via **`baseline_components` + explain_v2**. |
| P3 | Calibration / monitoring | **Partial** — aggregate log env + audit script + assumptions text; Mongo **`value`** quality remains a data product concern. |

---

## Commands

```bash
pnpm run audit:valuation-response
```

Script: [`scripts/valuation-response-audit.ts`](../scripts/valuation-response-audit.ts).
