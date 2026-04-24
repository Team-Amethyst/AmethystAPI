# Pre-deploy testing — how to obtain API keys

Use this when wiring **GitHub Actions** (or any CI) to hit live services before you ship. Two different keys are involved: the **Engine** accepts `x-api-key`; the **Draft** API accepts `x-player-api-key` or `Authorization: Bearer` for the shared player test key.

---

## Base URLs (replace if your team uses different App Runner hosts)

| Service | Example base URL |
|---------|------------------|
| **Draft API** | `https://at5ms22dhj.us-east-1.awsapprunner.com` |
| **Engine API** | `https://q6dbuvmuvh.us-east-1.awsapprunner.com` |

Paths below are relative to that origin (no trailing slash required on the host).

---

## Engine API — generate an `x-api-key` (Amethyst Engine)

The Engine does **not** use `x-player-api-key`. Every analytical route expects:

```http
x-api-key: <ENGINE_API_KEY>
```

### Option A — Developer portal (recommended for humans)

1. In a browser, open the Engine base URL (same host as the API, e.g. `https://q6dbuvmuvh.us-east-1.awsapprunner.com/`).
2. Open the **Get a key** tab.
3. Complete the wizard (license label is required; billing step is simulated only).
4. When the key appears, **copy it once** and store it somewhere safe (password manager or GitHub **Actions secret**, e.g. `AMETHYST_API_TEST_KEY`). The server will not show the full secret again.

If the tab says issuance is disabled, the operator must set **`KEY_ISSUANCE_ENABLED`** to `1` / `on` (or unset) on the Engine App Runner service and redeploy before you can mint a key.

### Option B — `curl` (good for automation after you confirm issuance rules)

1. **Check that issuance is on** (optional but avoids blind failures):

   ```bash
   curl -sS "https://q6dbuvmuvh.us-east-1.awsapprunner.com/api/keys/status"
   ```

   Expect JSON like `{ "issuanceEnabled": true, "requiresToken": false }`. If `requiresToken` is `true`, the operator must share the **`KEY_ISSUANCE_SECRET`** value so you can send header **`X-Key-Issuance-Token`** on the issue call.

2. **Mint a key** (no issuance token on the server):

   ```bash
   curl -sS -X POST "https://q6dbuvmuvh.us-east-1.awsapprunner.com/api/keys/issue" \
     -H "Content-Type: application/json" \
     -d '{"owner":"github-actions-predeploy","tier":"free"}'
   ```

   If the server requires an issuance token:

   ```bash
   curl -sS -X POST "https://q6dbuvmuvh.us-east-1.awsapprunner.com/api/keys/issue" \
     -H "Content-Type: application/json" \
     -H "X-Key-Issuance-Token: <KEY_ISSUANCE_SECRET_VALUE>" \
     -d '{"owner":"github-actions-predeploy","tier":"free"}'
   ```

3. From the JSON response, copy the **`apiKey`** string (format like `amethyst_live_…`). That entire string is the value for **`x-api-key`** on subsequent Engine requests.

4. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Paste the key into a secret such as **`AMETHYST_API_TEST_KEY`**. Reference it in workflow steps as `${{ secrets.AMETHYST_API_TEST_KEY }}` (do not echo it in logs).

**Typical failures**

- **`401` / missing key on protected routes** — header missing or wrong value.
- **Issuance disabled** — operator set **`KEY_ISSUANCE_ENABLED=0`** (or `false` / `off`) on Engine; fix env and redeploy, or use an operator-created key via **`POST /api/keys`** instead.

---

## Draft API — `PLAYER_API_TEST_KEY` (not minted on the Engine)

Draft’s **`POST /api/players/valuations`** (and related player routes) authenticate with the **shared test key** configured on the **Draft** service, not with the Engine portal.

1. **Obtain the value from your team** — it lives in the Draft deployment environment (same concept as `PLAYER_API_TEST_KEY` in AmethystDraft). Whoever operates Draft App Runner / secrets owns rotation.
2. **Store it in GitHub** as a secret, e.g. **`PLAYER_API_TEST_KEY`**.
3. **Send it on every Draft request** using either header style:

   ```http
   x-player-api-key: <PLAYER_API_TEST_KEY>
   ```

   or

   ```http
   Authorization: Bearer <PLAYER_API_TEST_KEY>
   ```

**Typical failures**

- **`401`** — key header missing, typo, or value does not match what Draft has configured.
- **`503`** — Draft is running but the operator has **not** configured a player test key on the server; fix Draft env / secrets and redeploy Draft (not the Engine).

---

## Quick check after secrets are set

**Engine** (replace URL and secret name to match your workflow):

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST "https://q6dbuvmuvh.us-east-1.awsapprunner.com/valuation/calculate" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $AMETHYST_API_TEST_KEY" \
  -d '{"roster_slots":[{"position":"OF","count":3}],"scoring_categories":[{"name":"HR","type":"batting"}],"total_budget":260,"num_teams":12,"league_scope":"Mixed","drafted_players":[]}'
```

Expect **`200`** when the key and body are valid.

**Draft** (checkpoint body from your fixture file):

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST "https://at5ms22dhj.us-east-1.awsapprunner.com/api/players/valuations" \
  -H "Content-Type: application/json" \
  -H "x-player-api-key: $PLAYER_API_TEST_KEY" \
  --data-binary @pre_draft.json
```

Expect **`200`** when Draft, Engine, Mongo, and keys are all correctly configured.

---

**Reminder:** Engine **`CORS_ORIGIN`** only affects **browser** calls to the Engine. CI `curl` / Node requests do not need CORS. If you add **browser-based** smoke tests from a hosted SPA, ensure **`CORS_ORIGIN`** on the Engine App Runner service lists that SPA’s origin (comma-separated if several).
