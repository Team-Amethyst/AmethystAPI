# Amethyst Engine

Stateless analytical API for fantasy baseball. Receives draft state and league settings, returns mathematical valuations. No user accounts or league state are stored — every request is self-contained.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + Express 5 |
| Language | TypeScript |
| Database | MongoDB (player data, API keys) |
| Cache | Redis (optional, degrades gracefully without it) |
| Deploy | AWS App Runner via GitHub Actions |

---

## Endpoints

All Brain endpoints require an `x-api-key` header. See [Authentication](#authentication).

### `POST /valuation/calculate`
Returns every undrafted player with an inflation-adjusted auction value and a **Steal / Reach / Fair Value** indicator.

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
| `budget_by_team_id` | `team_id` → **remaining** auction dollars; when set, total remaining = sum of values (ignores `sum(paid)`) |
| `scoring_format` | `5x5` \| `6x6` \| `points` (validated; v1 inflation may ignore) |
| `hitter_budget_pct`, `pos_eligibility_threshold` | Forward-compatible; v1 math may ignore |
| `minors`, `taxi` | `{ team_id, players[] }[]` on flat bodies; nested fixtures may still use a legacy record map |
| `deterministic` | Fixed `calculated_at` and stable sorts |
| `seed` | With `deterministic`, seeded tie-breaks so CI can pin ordering |
| `player_ids` | Value only these undrafted ids (subset / perf) |

**Validation errors** return `400` with `{ "errors": [{ "field": "drafted_players.0.position", "message": "..." }] }` (JSON path style, no stack traces). Version failures use `field: "schema_version"`.

**Auth:** Draft calls this route with `x-api-key` (`AMETHYST_API_KEY`). The Draft-only `PLAYER_API_TEST_KEY` is not used here.

### `POST /catalog/batch-values`
Returns baseline `value`, `tier`, and `adp` from the engine catalog (Mongo) for the requested `player_ids`. Merge with MLB bios in the Draft app. `league_scope` filters the result list. `pos_eligibility_threshold` is reserved for future eligibility alignment.

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

Keys are stored in the `apikeys` MongoDB collection. To create one, run in Atlas mongosh:

```js
use amethystapi
db.apikeys.insertOne({
  key: "your-generated-key",   // 16–128 alphanumeric chars
  owner: "team-name",
  email: "team@example.com",
  tier: "premium",             // free | standard | premium
  usageCount: 0,
  lastUsed: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date()
})
```

Generate a key:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

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

---

## Deployment

Push to `main` — GitHub Actions builds, pushes to ECR, and triggers an App Runner deployment automatically.

**Required GitHub secrets:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

**App Runner health check:** `GET /api/health` on port `8080`

**MongoDB Atlas:** Network Access must allow `0.0.0.0/0` (App Runner has no static IP).

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

Run tests: `pnpm test` (Vitest + snapshots over `test-fixtures/player-api/`).

