# Amethyst Engine — agent brief (Draft ↔ Engine contract)

**Repos:** Draft is **AmethystDraft** (`apps/api`). Engine is a separate service; Draft calls it over HTTP with axios (`apps/api/src/lib/amethyst.ts`).

## Auth and transport

- **Base URL:** `AMETHYST_API_URL` (no trailing path segment required beyond what you mount).
- **Auth header on every request:** `x-api-key: <AMETHYST_API_KEY>` (Draft sets this from env).
- **Correlation:** Draft sends **`X-Request-Id`** when a request id is in context. Engine should **echo the same `X-Request-Id` on responses** so the Draft BFF can forward it to browsers/graders (`forwardEngineCorrelationHeaders`).
- **Timeout:** Draft defaults to **15s** per Engine call; override with **`AMETHYST_ENGINE_TIMEOUT_MS`** on the Draft side. **`POST /valuation/calculate` is not retried** on the Draft side.

**Developer portal (human operators, not Draft):** The Engine serves `public/index.html`. When **`KEY_ISSUANCE_ENABLED=1`**, **`GET /api/keys/status`** and **`POST /api/keys/issue`** mint MongoDB keys (plaintext returned once). Optional **`KEY_ISSUANCE_SECRET`** + header **`X-Key-Issuance-Token`**. Draft continues to use only **`x-api-key`** on Brain routes.

## Endpoints Draft calls today

| Method | Path (relative to Engine base URL) | Notes |
|--------|-------------------------------------|--------|
| `POST` | `/valuation/calculate` | JSON body: **flat** valuation context (see below). |
| `POST` | `/valuation/player` | Same body as calculate plus **`player_id`**; returns one row under `player` plus full response envelope. |
| `POST` | `/analysis/scarcity` | JSON body: scarcity context; optional `position` in body when Draft passes `?position=`. |
| `POST` | `/simulation/mock-pick` | JSON body: `pick_order`, `roster_slots`, `league_scope`, `teams[]`, optional `available_player_ids`. |
| `POST` | `/simulation/mock-draft` | **Alias** of `mock-pick` (same handler; clearer product naming). |
| `GET`  | `/signals/news` | Query: optional `days`, `signal_type` (strings in query; Draft forwards as `params`). |
| `GET`  | `/signals/news-signals` | **Alias** of `/signals/news` (shared cache key by query params). |

## Draft ↔ Engine coupling audit (AmethystDraft repo)

These Draft-side locations must stay aligned with the table above when paths, auth headers, or valuation body shapes change. This repo does not vendor AmethystDraft; treat this list as the integration checklist.

| Draft path | Engine usage |
|------------|----------------|
| `apps/api/src/lib/amethyst.ts` | HTTP client (base URL, `x-api-key`, timeouts, which paths are called). |
| `apps/api/src/lib/engineContext.ts` | Builds flat **`EngineValuationContext`** / valuation POST body for Engine. |
| `apps/api/src/routes/engine.ts` (or equivalent) | BFF routes that forward to Engine. |
| `apps/api/engine-contract/engineRepoHandoff.ts` | In-repo contract checklist (mirror of this brief). |
| `apps/api/schemas/valuation-request.v1.schema.json` | Nested schema; Draft may flatten before Engine. |

## Versioned URL aliases (`/v1/...`)

The Engine also mounts **the same licensed routers** under a **`/v1` prefix** (same middleware and rate limits). New integrations may prefer these paths; **`/v1` and legacy paths are equivalent** until a deprecation is announced.

| Legacy path | Versioned alias |
|-------------|-----------------|
| `POST /valuation/calculate` | `POST /v1/valuation/calculate` |
| `POST /valuation/player` | `POST /v1/valuation/player` |
| `POST /catalog/batch-values` | `POST /v1/catalog/batch-values` |
| `POST /analysis/scarcity` | `POST /v1/analysis/scarcity` |
| `POST /simulation/mock-pick` | `POST /v1/simulation/mock-pick` |
| `POST /simulation/mock-draft` | `POST /v1/simulation/mock-draft` |
| `GET /signals/news` | `GET /v1/signals/news` |
| `GET /signals/news-signals` | `GET /v1/signals/news-signals` |

**Deprecation policy:** Legacy unprefixed paths remain supported for existing Draft deployments. If a breaking change is ever required, ship **`/v1`** behavior first, update Draft’s `amethyst` client, then remove legacy routes in a coordinated release (and bump `ENGINE_CONTRACT_VERSION` / OpenAPI).

## Frontend migration notes (explainability v2)

- Existing valuation fields remain unchanged (`inflation_factor`, `players_remaining`, `valuations[]`, `why`, etc.).
- Prefer `context_v2` for top-level UI cards:
  - `market_summary` for headline + inflation + budget/player counts
  - `position_alerts` for deterministic, severity-ranked urgency cards
  - `confidence` + `assumptions` for trust/caveat display
- Prefer row-level `explain_v2` over free-text parsing:
  - `auction_target` / `list_value` for display values
  - `adjustments` for reconciled math chips
  - `drivers[]` for ordered impact reasons
- `market_notes` is still returned for compatibility and is now generated from `context_v2` to keep both layers consistent.

## `POST /valuation/calculate` — flat body (no wrapper)

Draft ends every valuation call with **`finalizeEngineValuationPostPayload()`** after building `EngineValuationContext` in `apps/api/src/lib/engineContext.ts`. Treat the POST body as a **single JSON object** with (at least) these concepts:

- **`roster_slots`**, **`scoring_categories`**, **`total_budget`**, **`num_teams`**, **`league_scope`** (`Mixed` | `AL` | `NL`).
- **`drafted_players`**: **auction picks only** (not keepers bucketed separately).
- **`pre_draft_rosters`**: optional keepers / pre-auction roster sections (nested array of `{ team_id, players[] }` or flat record keyed by `team_id` — Draft supports both shapes upstream; normalize/validate in Engine per your contract).
- **`budget_by_team_id`**: optional map of remaining budgets.
- **`schema_version`** and/or **`schemaVersion`**: when Draft sets a version, **`finalizeEngineValuationPostPayload` duplicates `schema_version` → `schemaVersion` if only snake_case is set** (Engine merge rules).
- Optional: **`player_ids`**, **`minors`**, **`taxi`**, **`checkpoint`**, **`scoring_format`**, **`hitter_budget_pct`**, **`pos_eligibility_threshold`**, **`deterministic`**, **`seed`** (for **reproducible Activity #9 grading** — honor when present).

**`player_id`:** MLB Stats API **person id as string**, aligned with Draft **`externalPlayerId`**.  
**`team_id`:** canonical **`team_1` … `team_K`** in fixtures and Engine payloads.

## Validation errors (must match Draft UI / graders)

On validation failure, respond **`400`** with JSON:

```json
{ "errors": [{ "field": "string", "message": "string" }] }
```

Draft’s error handler **forwards that body as-is** for Engine 400s with this shape (no `AppError` wrapper).

## Canonical schema and fixtures (copy or mirror in Engine)

1. **JSON Schema (nested Activity #9 fixture shape + field definitions):**  
   `AmethystDraft/apps/api/schemas/valuation-request.v1.schema.json`  
   - Describes **nested** documents (`schemaVersion`, `checkpoint`, `league`, `draft_state`, optional `pre_draft_rosters`, …).  
   - Draft **`POST /api/players/valuations`** accepts nested **or** flat; it converts to the flat Engine context before calling Engine.  
   - Engine should still **validate the flat `/valuation/calculate` body** you actually receive (derive OpenAPI / JSON Schema from the same field names as `EngineValuationContext` in `engineContext.ts` if helpful).

2. **Golden fixtures for integration tests:**  
   `AmethystDraft/apps/api/test-fixtures/player-api/`  
   - `checkpoints/*.json` — full nested valuation-request docs.  
   - `league.base.json` — reusable league block.  
   - `README.txt` — how Draft uses them and test-key header for **`POST /api/players/valuations`**.

3. **Draft-only test entry (optional for you):** graders hit Draft with **`x-player-api-key: <PLAYER_API_TEST_KEY>`** on **`POST /api/players/valuations`** with the same JSON; Draft forwards to Engine after validation.

## Response versioning (optional but aligned with Draft)

Draft’s web client allows **`engine_contract_version`** (or similar) on valuation responses when Engine sends it. If you add response versioning, document the field name and bump rules alongside Draft **`schemaVersion`** (e.g. `1.0.0`).

## Reliability note (set expectations)

Valuations depend on Engine uptime, Draft Mongo consistency for live league routes, and catalog/data freshness. There is no claim of universal “bulletproof” behavior without Engine + data in good shape.

## Checklist (Engine work items)

1. Implement or verify **`POST /valuation/calculate`** against the **flat** contract above; accept **`schema_version` / `schemaVersion`** duplication rules.  
2. Validate requests (schema or codegen); **400 + `{ errors: [...] }`**.  
3. **Echo `X-Request-Id`**.  
4. **`deterministic` + `seed`** for reproducible grading.  
5. Integration tests using **`test-fixtures/player-api/checkpoints/*.json`** (and/or equivalent flat bodies after conversion).  
6. Document **`player_id`** = MLB person id string.

---

**Files in Draft the Engine agent should open for details:**  
`apps/api/src/lib/engineContext.ts` (payload shapes), `apps/api/src/routes/engine.ts` (paths), `apps/api/engine-contract/engineRepoHandoff.ts` (same checklist in code), `apps/api/schemas/valuation-request.v1.schema.json`.

---

That is everything you need to hand off; no extra clarification is required unless Engine’s actual routes or auth differ from the above—in that case, update the table and the Draft `amethyst` caller to match.
