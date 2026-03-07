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

```json
{
  "roster_slots": [{ "position": "OF", "count": 3 }],
  "scoring_categories": [{ "name": "HR", "type": "batting" }],
  "total_budget": 260,
  "num_teams": 12,
  "drafted_players": [],
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
# Fill in MONGO_URI and JWT_SECRET

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
| `JWT_SECRET` | Random hex (64 bytes) | Same value |
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
src/
  index.ts              # App entry point, route mounting
  types/brain.ts        # Shared TypeScript interfaces
  lib/
    redis.ts            # Redis client (non-fatal on failure)
    leagueScope.ts      # AL/NL/Mixed player filtering
  middleware/
    apiKey.ts           # x-api-key validation + usage tracking
    cache.ts            # Redis response cache
    auth.ts             # JWT auth (existing user routes)
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
    scarcity.ts         # POST /analysis/scarcity
    simulation.ts       # POST /simulation/mock-pick
    signals.ts          # GET /signals/news
    auth.ts             # POST /api/auth/* (existing)
    players.ts          # GET /api/players (existing)
```

