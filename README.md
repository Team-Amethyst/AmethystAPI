# Amethyst Engine

Stateless analytical API for fantasy baseball. Receives draft state and league settings, returns mathematical valuations. No user accounts or league state are stored — every request is self-contained.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + Express 5 |
| Language | TypeScript |
| Database | MongoDB (player data, API keys) |
| Cache | Redis (API key cache, catalog batch-values — **not** used for `POST /valuation/calculate`) |
| Deploy | AWS App Runner via GitHub Actions |

---

## Environment variables

- `MONGO_URI`: MongoDB connection string.
- `REDIS_URL`: Redis connection string (optional, default `redis://localhost:6379`).
- `API_KEY_PEPPER`: Server-side secret used to hash stored API keys. Must be set in production to protect key material.

## API contract (Draft / Engine alignment)

| Artifact | Role |
|---|---|
| [ENGINE_AGENT_BRIEF.md](ENGINE_AGENT_BRIEF.md) | **Handoff for agents / new contributors** — Draft ↔ Engine HTTP contract, headers, flat valuation body, fixtures, checklist. |
| [docs/valuation-response-field-audit.md](docs/valuation-response-field-audit.md) | **Response-field semantics & QA** — what each valuation field means, known decomposition gaps, `pnpm run audit:valuation-response`. |
| [docs/valuation-inflation-semantics.md](docs/valuation-inflation-semantics.md) | **Inflation contract** — `inflation_model` (`global_v1` vs `surplus_slots_v1`), `player_ids` as output filter, `inflation_raw` / cap-floor, aggregates. |
| [docs/valuation-module-map.md](docs/valuation-module-map.md) | **Code ownership map** — which valuation module owns inflation branch logic, recommended-bid heuristics, and team-adjusted economics. |
| [openapi/openapi.yaml](openapi/openapi.yaml) | **Human-facing API spec** — paths, headers, success/error shapes, budget rules, tracing. |
| [schemas/valuation-request.v1.schema.json](schemas/valuation-request.v1.schema.json) | **Machine validation** for the flat `POST /valuation/calculate` body (keep in sync with Draft). |
| [schemas/valuation-request-v1.json](schemas/valuation-request-v1.json) | Nested `{ league, draft_state }` alternate (fixtures / legacy). |

### AmethystDraft BFF (`finalizeEngineValuationPostPayload`)

The Engine accepts the **flat** body Draft builds for server-to-server calls:

- **`drafted_players`:** auction picks only (keepers on rosters belong in **`pre_draft_rosters`**, not double-listed here, unless you intentionally mirror Draft’s model).
- **`pre_draft_rosters`:** optional **map** (`team_id` → array of rows) **or** **array** of `{ team_id, players }` (same as Draft checkpoints).
- **`schema_version` / `schemaVersion`:** both optional; if both are sent, **`schemaVersion` (camelCase) wins**.
- **`inflation_model`:** optional, defaults to **`global_v1`**. Set **`replacement_slots_v2`** for Draftroom-quality slot/position-aware surplus inflation (preferred). **`surplus_slots_v1`** is a lighter single-cutoff surplus model. Remaining-slot math for surplus models uses `roster_slots`, `num_teams`, `drafted_players`, keepers/minors/taxi, and eligibility.
- **`player_ids`:** optional subset of undrafted MLB ids to **return** in `valuations[]`; does not shrink the inflation basis (see [valuation-inflation-semantics.md](docs/valuation-inflation-semantics.md)).
- **Responses:** **`engine_contract_version: "1"`** on success; **`X-Request-Id`** echoed when sent.
- **Errors:** **400** = request validation only, body **`{ errors: [{ field, message }] }`**. **422** = output sanity failure, same `errors` shape, **no** prices.

**Budget (integration-tested):**

| `budget_by_team_id` | Remaining league dollars |
|---|---|
| Absent or `{}` | `total_budget × num_teams` − **Σ `drafted_players[].paid`** (missing `paid` → 0). |
| Present, non-empty | **Sum of map values**; **`paid` on drafted rows is ignored** for that request. |

**Fixture paths:** CI uses [test-fixtures/player-api/checkpoints/](test-fixtures/player-api/checkpoints/). If AmethystDraft is a **sibling** repo (`…/dev/AmethystDraft`), tests prefer `apps/api/test-fixtures/player-api/checkpoints/pre_draft.json` when present so nested checkpoints run too (including `league.roster_slots` as a **slot → count** map, normalized server-side to `[{ position, count }, …]`).

**Draft replay analysis (per-pick, full board):** `pnpm replay-draft-json-analysis` replays **`pre_draft.json` + `after_pick_130.json`** (defaults under `test-fixtures/player-api/checkpoints/`), rewinding `drafted_players` before each pick and scoring vs fixture `paid`. **`pnpm replay-draft-json-analysis:report`** / **`:mongo-report`** write JSON under **`tmp/`** (gitignored); use **`--out path`** for a different file. Mongo mode merges fixture ids via [`src/lib/replayMongoFixtureMerge.ts`](src/lib/replayMongoFixtureMerge.ts) (`MONGO_URI` from `.env`).

**`pre_draft_rosters` (v1 behavior):** Accepted as **map or array** (see above); rows do **not** remove players from the undrafted pool until those `player_id`s appear in **`drafted_players` / `draft_state`**. **`minors` / `taxi` do not affect spend** in v1.

**Draft economics (400):** Each `player_id` at most once in auction rows; **`paid` ≥ 0**; without **`budget_by_team_id`**, **Σ `paid` ≤ `total_budget × num_teams`**.

**Operational hardening:** Request bodies are limited to **1 MB**. **`POST /valuation/calculate`** is **not** Redis-cached (avoids stale prices after player sync). **Rate limits** (per `x-api-key`, or IP if the key is missing): defaults **~300/min** on `/valuation/calculate`, **~1200/min** on `/catalog/batch-values` — controlled with **`RATE_LIMIT_ENABLED`** (`0`/`off` to disable), **`RATE_LIMIT_VALUATION_MAX`**, **`RATE_LIMIT_VALUATION_WINDOW_MS`**, **`RATE_LIMIT_CATALOG_MAX`**, **`RATE_LIMIT_CATALOG_WINDOW_MS`**. Limits are **off under Vitest** unless **`RATE_LIMIT_ENABLED=1`**.

**Logging:** JSON logs via **Pino**; set **`LOG_LEVEL`** (`debug`, `info`, `warn`, `error`, `silent`). Defaults to **`silent` in tests** unless `LOG_LEVEL` is set.

**Health:** **`GET /api/health`** — liveness. **`GET /api/health/ready`** — MongoDB + optional Redis ping; **`503`** if Mongo is not connected. Set **`HEALTHCHECK_REDIS=0`** to skip the Redis check (status stays `ready` if Mongo is up).

---

## Valuation model vs course activity (UML)

The course diagram expects: ingest league + player state → choose **Rotisserie vs points** scoring → per-player projections/surplus → **auction dollars** → **validate reasonableness** (retry loop in your design doc).

**This service today**

| Diagram step | Where it lives now | Your “own model” (course) |
|---|---|---|
| League + draft state | Request body → `parseValuationRequest` / `NormalizedValuationInput` | Draft/fixtures build this; not outsourced. |
| Eligible player bios & history | Mongo `players` (`stats`, `projection`, `value`, `tier`, `adp`, …) | **You** populate via sync/analytics (e.g. 3-year stats, age, role, injury) — not a third-party valuation API. |
| Filter drafted / scope | `calculateInflation` + `league_scope` | Same. |
| Scoring branch (Roto vs points) | `resolveScoringMode` in [`src/services/valuationWorkflow.ts`](src/services/valuationWorkflow.ts) — logged as `scoring_mode`; **v1 math still uses stored `value` for both** | Next increment: compute or rescale `value` per `scoring_format` + `scoring_categories` before inflation. |
| Surplus / scarcity / market | Baseline `value` + inflation vs remaining budget + Steal/Reach vs ADP | Extend `inflationEngine` / scarcity as you add SABR-style signals. |
| Auction dollars | `adjusted_value` on each row | Same. |
| Validate prices | [`src/lib/valuationQuality.ts`](src/lib/valuationQuality.ts) — finite numbers, non-negative totals, valid indicators; failures → **HTTP 422** with `{ errors: [...] }` and **no** `valuations` payload (fail closed) | Add caps / recompute loop inside `executeValuationWorkflow` when you have tunables. |

**Orchestration:** [`executeValuationWorkflow`](src/services/valuationWorkflow.ts) is the single entry used by `POST /valuation/calculate` so the pipeline stays explicit and testable.

---

## Endpoints

All Brain endpoints require an `x-api-key` header. See [Authentication](#authentication).

### `POST /valuation/calculate`
Returns every undrafted player with an inflation-adjusted auction value and a **Steal / Reach / Fair Value** indicator.
Baseline values are now scoring-aware (`5x5` / `6x6` / `points`) and include bounded scarcity/replacement adjustments before inflation.

The **AmethystDraft** API forwards a single JSON object (no extra wrapper): either the merged body from `buildEngineValuationCalculateBodyFromFixture` or live league/roster state. Canonical JSON Schema for the flat fixture shape: [schemas/valuation-request.v1.schema.json](schemas/valuation-request.v1.schema.json) (align with Draft `apps/api/schemas/valuation-request.v1.schema.json` when present). Nested `{ league, draft_state }` is still accepted for older tests; see [schemas/valuation-request-v1.json](schemas/valuation-request-v1.json).

**Flat body (Draft upstream):**

```json
{
  "schema_version": "1.0.0",
  "checkpoint": "pre_draft",
  "roster_slots": [{ "position": "OF", "count": 3 }],
  "scoring_categories": [{ "name": "HR", "type": "batting" }],
  "total_budget": 260,
  "num_teams": 12,
  "league_scope": "Mixed",
  "scoring_format": "5x5",
  "drafted_players": [],
  "deterministic": true,
  "seed": 42,
  "minors": [],
  "taxi": []
}
```

(`schemaVersion` camelCase is accepted as an alias for `schema_version`.)

**`drafted_players` / `draft_state` rows:** `player_id` is the **MLB Stats API person id** as a string (same as Draft `externalPlayerId` and Mongo `mlbId`). Use `position` as the primary slot; optional `positions[]` carries full eligibility. At least one of `position`, `positions[]`, or `roster_slot` must yield a primary position.

**Optional fields:**

| Field | Purpose |
|---|---|
| `schema_version` / `schemaVersion` | Contract version; majors `0` and `1` supported |
| `checkpoint` | e.g. `pre_draft`, `after_pick_10`, … (logged, no PII) |
| `league_id` | Optional; echoed in `context_v2.scope.league_id`. Nested bodies may use `league.id` instead; top-level `league_id` wins |
| `budget_by_team_id` | Per-team **remaining** $; when non-empty, league remaining = **sum(map)** and **`paid` ignored** — see [API contract](#api-contract-draft--engine-alignment) |
| `scoring_format` | `5x5` \| `6x6` \| `points` (validated; v1 inflation may ignore) |
| `hitter_budget_pct`, `pos_eligibility_threshold` | Forward-compatible; v1 math may ignore |
| `minors`, `taxi` | `{ team_id, players[] }[]` on flat bodies; nested fixtures may still use a legacy record map |
| `deterministic` | Fixed `calculated_at` and stable sorts |
| `seed` | With `deterministic`, seeded tie-breaks so CI can pin ordering |
| `player_ids` | Limit `valuations[]` to these undrafted ids; **inflation pool stays full undrafted set** |

**Validation errors** return `400` with `{ "errors": [{ "field": "drafted_players.0.position", "message": "..." }] }` (JSON path style, no stack traces). Version failures use `field: "schema_version"`.
When quality checks fail, workflow performs bounded recompute passes (inflation cap/floor clamps) before fail-closed `422`.

**Auth:** Draft calls this route with `x-api-key` (`AMETHYST_API_KEY`). The Draft-only `PLAYER_API_TEST_KEY` is not used here.

### `POST /valuation/player`
Single-player valuation convenience route. Accepts the same league and draft context as `/valuation/calculate`, plus required `player_id`, and returns:

- full valuation metadata (`inflation_factor`, `players_remaining`, etc.)
- `valuations` as a single-item array
- `player` as the single valued row

If `player_id` is missing, returns `400` with `{ errors: [{ field: "player_id", message: "player_id is required" }] }`.
If `player_id` is not in the current valuation pool, returns `404` with `{ errors: [{ field: "player_id", message: "Player not found in valuation pool" }] }`.
`valuations[]` rows include optional explainability metadata:
- `baseline_components` (`scoring_format`, `projection_component`, `scarcity_component`)
- `scarcity_adjustment` — always `0` (roster scarcity is already in `baseline_value`)
- `inflation_adjustment` — full delta `adjusted_value - baseline_value` from the league-wide inflation factor

Deploy label **`valuation_model_version`**: env `VALUATION_MODEL_VERSION`, or Docker `BUILD_GIT_SHA` (CI sets this), else `package.json` `name@version`. Set **`VALUATION_AGGREGATE_LOG=1`** for structured per-request pool/inflation logs.

### `POST /catalog/batch-values`
First-class baseline read: same **`player_id`** rules as valuation (string MLB id / `mlbId`). Returns **`engine_contract_version`** plus `players[]`. Responses are **cached 120s** per request body (Redis when configured). Merge with MLB bios in Draft. `league_scope` filters the list. `pos_eligibility_threshold` is reserved for future eligibility rules.

```json
{
  "player_ids": ["660271", "592450"],
  "league_scope": "Mixed"
}
```

### `POST /analysis/scarcity`
Returns positional scarcity scores and **Monopoly Detection** warnings when one team controls a disproportionate share of a scoring category.

```json
{
  "drafted_players": [...],
  "scoring_categories": [{ "name": "SV", "type": "pitching" }],
  "position": "SS",
  "num_teams": 12,
  "league_scope": "Mixed"
}
```

### `POST /simulation/mock-pick`
Predicts the most likely next pick for each team in the draft order using ADP + roster-need heuristics. Powers the AI Practice Draft environment.

```json
{
  "pick_order": ["team_1", "team_2"],
  "teams": [{ "team_id": "team_1", "roster": [] }],
  "roster_slots": [{ "position": "SP", "count": 5 }],
  "league_scope": "Mixed"
}
```

### `GET /signals/news`
Returns injury updates, role changes, trades, promotions, and demotions sourced from the MLB Transactions API.

```
GET /signals/news?days=7&signal_type=injury
```

`signal_type` options: `injury` | `role_change` | `trade` | `demotion` | `promotion`

---

## Authentication

Every request to the analytical endpoints requires:

```
x-api-key: <your-key>
```

Keys are stored in the `apikeys` MongoDB collection.

### One-off keys (developer portal)

The bundled developer portal (**Get a key** tab) can mint a key through **`POST /api/keys/issue`** unless issuance is explicitly turned off. The plaintext is returned **once** in the JSON body; there is no account recovery.

- **`GET /api/keys/status`** — `{ "issuanceEnabled": boolean, "requiresToken": boolean }` for the UI. Issuance defaults to **on**; set **`KEY_ISSUANCE_ENABLED=0`**, **`false`**, or **`off`** to disable.
- **`POST /api/keys/issue`** — JSON body `{ "owner": string (required), "email"?: string, "tier"?: "free" | "standard" | "premium" }`. If **`KEY_ISSUANCE_SECRET`** is set in the environment, clients must send header **`X-Key-Issuance-Token`** with the same value.

Example (local, issuance enabled, no secret):

```bash
curl -sS -X POST "http://localhost:3002/api/keys/issue" \
  -H "Content-Type: application/json" \
  -d '{"owner":"local-dev","tier":"free"}' | jq .
```

Successful responses include **`apiKey`**, a single string of the form **`amethyst_live_<hex>.<hex>`** (use it as the `x-api-key` value). **`POST /api/keys`** is the full programmatic create (label, owner, tier, scopes, optional expiry); **`POST /api/keys/issue`** is the portal-oriented shortcut (all scopes, no expiry).

For **CI / pre-deploy smoke tests** that call both **Engine** (`x-api-key`) and **Draft** (`x-player-api-key` / Bearer), use the same step-by-step tone as your runbooks: [docs/pre-deploy-testing-keys.md](docs/pre-deploy-testing-keys.md).

### Manual documents (MongoDB)

New keys are stored **hashed** (`keyHash`, `keyPrefix`, `label`, `owner`, `tier`, `scopes`, …). Prefer the **`POST /api/keys`** or **`POST /api/keys/issue`** APIs so hashing matches the server’s **`API_KEY_PEPPER`** / **`APP_SECRET`**. The auth middleware still accepts legacy documents that store a plaintext **`key`** for migration. See **`src/models/ApiKey.ts`** and **`src/routes/apiKeys.ts`** for the canonical shape.

On startup the server runs best-effort compatibility hooks on **`apikeys`** (see **`src/lib/apiKeyCollection.ts`**): **`collMod`** to turn document validation off, and **drop** of a legacy **unique index on `key` alone** (hashed keys omit `key`; a unique `key_1` index makes every insert collide on `null`). These require Mongo privileges; failures are logged and skipped. New keys also receive a **unique synthetic `email`** when none is supplied, for clusters that keep a unique index on `email`.

Usage is tracked per key (`usageCount`) for royalty reporting.

---

## Local Development

**Prerequisites:** Node 20, pnpm 9, MongoDB Atlas access, Redis (optional)

```bash
# Install Redis (optional — API works without it)
brew install redis && brew services start redis

# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Fill in MONGO_URI

# Refresh catalog + verify eligibility quality
pnpm sync-players:verify

# Start dev server (port 3002 — avoids conflict with draftroom on 3001)
pnpm dev
```

**Test an endpoint:**
```bash
curl -X POST http://localhost:3002/valuation/calculate \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-key>" \
  -d '{"roster_slots":[{"position":"OF","count":3}],"scoring_categories":[{"name":"HR","type":"batting"}],"total_budget":260,"drafted_players":[]}'
```

---

## Environment Variables

| Variable | Local | Production (App Runner) |
|---|---|---|
| `MONGO_URI` | Atlas connection string | Same |
| `PORT` | `3002` | `8080` |
| `CORS_ORIGIN` | `http://localhost:5173` | Production frontend URL |
| `REDIS_URL` | `redis://localhost:6379` | Upstash URL (when ready) |
| `KEY_ISSUANCE_ENABLED` | Omit or `1` / `on` (default **on**) | Set to **`0`**, **`false`**, or **`off`** to disable portal minting |
| `KEY_ISSUANCE_SECRET` | Optional shared secret for `X-Key-Issuance-Token` | Same — use for operator-gated issuance |

---

## Deployment

Push to `main` — GitHub Actions builds, pushes to ECR, and triggers an App Runner deployment automatically.

**Required GitHub secrets:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

**App Runner health check:** `GET /api/health` on port `8080`

**MongoDB Atlas:** Network Access must allow `0.0.0.0/0` (App Runner has no static IP).

**Key issuance:** Minting defaults **on** in the app (unset `KEY_ISSUANCE_ENABLED` means enabled). The Docker image also sets **`ENV KEY_ISSUANCE_ENABLED=1`** for clarity. To disable on App Runner, set **`KEY_ISSUANCE_ENABLED=0`** in the service environment (overrides the image). Optionally set **`KEY_ISSUANCE_SECRET`** and send **`X-Key-Issuance-Token`** on `POST /api/keys/issue`. Record intent in GitHub with `gh variable set KEY_ISSUANCE_ENABLED --body 1` when the API allows (does not change AWS by itself).

---

## League Scopes

Pass `league_scope` on any endpoint to filter the player pool:

| Value | Pool |
|---|---|
| `Mixed` (default) | All MLB players |
| `AL` | American League only |
| `NL` | National League only |

---

## Project Structure

```
openapi/
  openapi.yaml                      # OpenAPI 3.1 — API source of truth (with JSON Schema refs in prose)
schemas/
  valuation-request.v1.schema.json  # Flat Draft upstream (canonical)
  valuation-request-v1.json         # Nested league + draft_state (legacy tests)
test-fixtures/player-api/         # Engine samples; checkpoints/ mirrors Draft Activity #9 names
src/
  index.ts              # App entry point, route mounting
  types/brain.ts        # Shared TypeScript interfaces
  lib/
    redis.ts            # Redis client (non-fatal on failure)
    leagueScope.ts      # AL/NL/Mixed player filtering
    valuationQuality.ts # Reasonableness checks on valuation responses
    draftedPlayerZod.ts # Zod schema for drafted-player rows
    valuationRequest.ts # Zod parse + normalize (Draft flat vs nested v1)
    zodErrors.ts        # { field, message } for 400 bodies
  middleware/
    apiKey.ts           # x-api-key validation + usage tracking
    cache.ts            # Redis response cache
  models/
    ApiKey.ts           # Licensee key model
    Player.ts           # Master player data
  services/
    valuationWorkflow.ts # UML-aligned orchestration + quality gate
    inflationEngine.ts  # Auction inflation + Steal/Reach/Fair Value
    scarcityEngine.ts   # Positional scarcity + Monopoly Detection
    mockPickEngine.ts   # ADP + team-need draft simulator
    newsService.ts      # MLB Transactions API signals
  routes/
    valuation.ts        # POST /valuation/calculate
    catalog.ts          # POST /catalog/batch-values
    scarcity.ts         # POST /analysis/scarcity
    simulation.ts       # POST /simulation/mock-pick
    signals.ts          # GET /signals/news
```

Run tests: `pnpm test` (Vitest; CI runs this on every deploy). Watch mode: `pnpm test:watch`. Lint includes `test/` and `vitest.config.ts`.

