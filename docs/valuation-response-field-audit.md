# Valuation API response fields — meaning, correctness, and follow-ups

This document is the output of a **code-path review** plus **`pnpm run audit:valuation-response`** (mock catalog + `test-fixtures/player-api/checkpoints/*.json`). Re-run after you change pricing math or fixtures.

---

## How a response is produced (pipeline)

1. **`parseValuationRequest`** — normalizes Draft/flat/nested bodies to `NormalizedValuationInput`.
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
| **`inflation_factor`** | “Dollars chasing talent” ratio (budget left ÷ pool list $) | **Economically interpretable** only when **pool_value_remaining** is the sum of meaningful list prices. Capped/floored in workflow retries — **can sit at floor (e.g. 0.25)** when pool ≫ budget, which **compresses all `adjusted_value`s**; document that as “fail-soft clamp”, not neutral market. |
| **`total_budget_remaining`** | League dollars left | **Reliable** given request semantics: either **`budget_by_team_id`** sum or `total_budget * num_teams - Σ paid` (+ keeper spend rules from workflow). |
| **`pool_value_remaining`** | Σ `value` on **undrafted** players after baseline step | **Internally consistent** with how `adjusted_value` is computed. **Not** the same as a public “FG $” or DFS salary cap unless Mongo **`value`** is calibrated to that unit. |
| **`players_remaining`** | Count of undrafted rows in the valuation pool | **Reliable** after filters / `player_ids`. |
| **`calculated_at`** | Timestamp | **Reliable**; deterministic fixtures pin to epoch when `deterministic: true`. |
| **`valuation_model_version`** | Model / release label | **Cosmetic today** — hardcoded `"v2-expert-manual-shape"`. **Misleading** if operators treat it as a semver of deployed logic. Prefer build git SHA or real model package version. |
| **`valuations[]`** | Per-player rows | See below. |
| **`market_notes`**, **`context_v2`** | Narrative + structured cards | **Heuristic UX** built from scarcity + inflation; see **Explainability** section. |

---

## Per-row fields (`ValuedPlayer`)

| Field | Intended meaning | Confidence / caveats |
|-------|-------------------|----------------------|
| **`player_id`, `name`, `position`, `team`, `adp`, `tier`** | Echo catalog identity / sort keys | **Reliable** from Mongo lean row (subject to sync quality). |
| **`baseline_value`** | List / “pre-auction” $ before **league** inflation | **This is post-`scoringAwareBaselinePlayers`** — already includes **roster scarcity + projection bump** when those paths run. **Do not** read this as raw Mongo `value` unless you bypass baseline math. |
| **`adjusted_value`** | `baseline_value * inflation_factor` | **Mathematically consistent** with global factor. |
| **`indicator`** (Steal / Reach / Fair Value) | ADP rank vs **baseline value** rank mismatch | **Internally consistent** with current definitions; **not** “vs industry ADP consensus” unless Mongo `adp` is that source. |
| **`inflation_factor` (row)** | Copy of league factor | **Redundant** with top-level; same value every row. |
| **`baseline_components`** | `projection_component`, `scarcity_component`, `scoring_format` | **Reliable** when `__valuation_meta__` is populated by baseline engine. With **empty projections** (common in tests / thin sync), **`projection_component` is often ~0** and scarcity still moves **`value`** — users may think “projection is broken” when it is “no stats row”. |
| **`scarcity_adjustment`** | Documented in prose as “$ shift from scarcity” | **Not additive with `inflation_adjustment`**. Today `scarcity_adjustment = scarcity_component * baseline_value` while **`baseline_value` already embeds scarcity**. **`inflation_adjustment` is set to the full `adjusted - baseline` delta** (entire move from list to auction). So **`scarcity_adjustment + inflation_adjustment ≠ adjusted - baseline`** — measured **~$22** mismatch on mock+2026 fixtures (`audit:valuation-response`). **Treat `explain_v2.drivers` as illustrative, not a ledger.** |
| **`inflation_adjustment`** | Name suggests “part due to inflation” | **Actually equals total Δ** (`adjusted - baseline`). **Misnamed**; should be `total_value_delta` or split into **embedded scarcity** vs **league inflation** with a real decomposition. |
| **`why[]`** | Human bullets | Depends on the above; scarcity sentence can **overstate** when `scarcity_adjustment` double-counts semantics. |
| **`explain_v2`** | Structured drivers / confidence | **Drivers use `scarcity_adjustment` and `inflation_adjustment`** — same reconciliation issue. **`list_value` / `auction_target`** align with baseline/adjusted for the happy path. |

---

## `context_v2` and `market_notes`

- **`scope.league_id`** — often **`"unknown"`** unless the client sends **`league_id`**. Fine for Engine-only calls; **confusing** for multi-tenant dashboards — pass through from Draft when available.
- **`market_summary.headline`** — template from inflation % + top scarcity position. **Coherent** with `inflation_factor` and `analyzeScarcity` ordering.
- **`position_alerts`** — from **`analyzeScarcity`** on the **baseline-adjusted** pool; **aligned** with the same undrafted set used after drafted ids (not raw Mongo).
- **`assumptions` / `confidence`** — high-level copy; **review** if you change inflation math.

---

## What we ran (`audit:valuation-response`)

- **Catalog:** 512 synthetic players (same shape as valuation integration mock).
- **Fixtures:** all `*.json` in `test-fixtures/player-api/checkpoints/`.
- **Observed:** `inflation_factor` pinned at **0.25** (workflow floor) with large **`pool_value_remaining`** vs **`total_budget_remaining`** — expected when list dollars exceed remaining cash.
- **Observed:** **max |Δ − (scarcity_adj + infl_adj)| ≈ 21.99** across all rows — confirms decomposition issue is **systematic**, not fixture-specific.
- **Single-player slice:** the HTTP `/valuation/player` path merges the id into **`normalized.player_ids`**. Calling **`executeValuationWorkflow` directly** with only **`scope.playerId`** does **not** filter the pool — set **`input.player_ids`** (or rely on the route) so `valuations` and `players_remaining` match expectations.

---

## Recommended changes (priority)

1. **P0 — Honest API docs + OpenAPI** — Describe **`baseline_value`** as post-scarcity/projection list price; document **`scarcity_adjustment` / `inflation_adjustment` non-additivity** (or fix fields — see P2). Mention **inflation floor/cap** behavior.
2. **P1 — `valuation_model_version`** — Replace hardcoded string with **build id** or **configurable** `VALUATION_MODEL_VERSION` env so operators see what actually shipped.
3. **P1 — `league_id`** — Encourage Draft to send **`league_id`** so `context_v2.scope` is not `"unknown"`.
4. **P2 — Decomposition fix (breaking)** — Either:
   - set **`scarcity_adjustment`** to **0** and reserve scarcity story for **`baseline_components` + narrative**, with **`inflation_adjustment` = adjusted − baseline**; **or**
   - store **`mongo_raw_value`** (pre-baseline) and compute additive components that **sum to Δ**; **or**
   - add new fields **`value_delta`**, **`league_inflation_delta`**, **`scarcity_embedded_delta`** and deprecate old names in `/v1` only.

5. **P3 — Calibration** — `pool_value_remaining` vs real auction economy depends entirely on **`players.value`** quality; add monitoring / QA against known player sets.

---

## Commands

```bash
pnpm run audit:valuation-response
```

Script: [`scripts/valuation-response-audit.ts`](../scripts/valuation-response-audit.ts).
