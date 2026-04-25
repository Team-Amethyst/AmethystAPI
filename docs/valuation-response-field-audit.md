# Valuation API response fields — meaning, correctness, and follow-ups

This document tracks **code-path semantics** plus **`pnpm run audit:valuation-response`** (mock catalog + `test-fixtures/player-api/checkpoints/*.json`). Re-run after pricing or fixture changes.

---

## How a response is produced (pipeline)

1. **`parseValuationRequest`** — normalizes Draft/flat/nested bodies to `NormalizedValuationInput` (optional **`league_id`** or nested **`league.id`** for `context_v2`).
2. **`scoringAwareBaselinePlayers`** (`baselineValueEngine.ts`) — adjusts each catalog row’s **`value`** from Mongo using **`scoring_format`**, **`scoring_categories`**, **`roster_slots`** (projection stats when present, plus a scarcity multiplier). Stashes component hints on `projection.__valuation_meta__`.
3. **`calculateInflation`** (`inflationEngine.ts`) — removes drafted / off-board ids, computes **one** league-wide **`inflation_factor`** = remaining budget ÷ sum of remaining **baseline** dollars (then cap/floor in the workflow retry loop).
4. **Per row** — `adjusted_value = baseline_value * inflation_factor` (Steal/Reach from **value rank vs ADP rank** on that baseline-sorted pool).
5. **`validateValuationResponse`** — structural / finiteness checks (not economic truth).
6. **`attachValuationExplainability`** — adds `market_notes`, `why`, `explain_v2`, `context_v2` using **`analyzeScarcity`** on the **same baseline-adjusted** catalog passed into attach (aligned with pricing pool).

---

## Top-level fields (`ValuationResponse`)

| Field | Intended meaning | Confidence / caveats |
|-------|-------------------|----------------------|
| **`engine_contract_version`** | Wire format / drift detector for Draft | **Reliable** — constant from `ENGINE_CONTRACT_VERSION`. |
| **`inflation_factor`** | “Dollars chasing talent” ratio (budget left ÷ pool list $) | **Economically interpretable** only when **pool_value_remaining** is the sum of meaningful list prices. Capped/floored in workflow retries — **can sit at floor (e.g. 0.25)** when pool ≫ budget; document as clamp behavior, not neutral market. |
| **`total_budget_remaining`** | League dollars left | **Reliable** given request semantics: either **`budget_by_team_id`** sum or `total_budget * num_teams - Σ paid` (+ keeper spend rules from workflow). |
| **`pool_value_remaining`** | Σ `value` on **undrafted** players after baseline step | **Internally consistent** with how `adjusted_value` is computed. **Not** the same as a public “FG $” or DFS salary cap unless Mongo **`value`** is calibrated to that unit. |
| **`players_remaining`** | Count of undrafted rows in the valuation pool | **Reliable** after filters / `player_ids`. |
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
| **`adjusted_value`** | `baseline_value * inflation_factor` | **Mathematically consistent** with global factor. |
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
