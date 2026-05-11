# News signals realtime — Engine ↔ Draft alignment

**Canonical Draft-side doc:** In **AmethystDraft**, see `apps/api/engine-contract/NEWS_SIGNALS_REALTIME_ENGINE_PROMPT.md` (same contract from the consumer / BFF perspective).

## Status

- **Draft** ships Socket.IO + singleton poll + `POST /api/internal/news-signals/hook`.
- **Engine (this repo)** ships conditional `GET /signals/news` (ETag / `If-None-Match` / `304`) + outbound webhooks when MLB-backed snapshots change.

---

## Engine implementation summary

### 1. Conditional GET — ETag + 304

- **Validator:** SHA-256 hex of canonical JSON for `{ count, signals }` only (`fetched_at` excluded so the tag is stable).
- **Headers:** `ETag: "<64-char-hex>"` on `200` and `304`.
- **`If-None-Match`:** Parsed as quoted / unquoted and weak (`W/"..."`) — see `src/lib/signalsHttp.ts` (`ifNoneMatchIsCurrent`).
- **Fast path:** Redis sidecar `${signalsCacheKey}:http-etag` (TTL ≥ 24h while payload cache stays ~15m) can answer `304` without calling `fetchSignals` when the validator matches.
- **Second chance:** After `fetchSignals`, if the computed fingerprint matches `If-None-Match`, respond `304` (empty body).

### 2. Many Draft apps — per–API-key webhook (primary)

Each signed-up API key can register **its own** HTTPS endpoint. Engine fans out `signals_updated` to **every** active key that:

- has **`signals`** scope,
- has a non-empty **`newsSignalsWebhookUrl`** on the key document, and
- can resolve a **Bearer** token (see below).

**Portal registration (developer session):**

`PATCH /api/account/keys/:id/news-signals-webhook`

JSON body (any subset; send `newsSignalsWebhookUrl: null` or `""` to clear):

```json
{
  "newsSignalsWebhookUrl": "https://<their-draft-host>/api/internal/news-signals/hook",
  "newsSignalsWebhookBearer": "optional; omit to use the API key secret as Bearer"
}
```

- **`newsSignalsWebhookBearer`:** Optional. If set, stored sealed server-side and sent as `Authorization: Bearer …`. If omitted / cleared, Engine uses the **same plaintext API key** minted from the portal (stored sealed on the document) — matches Draft validating **`AMETHYST_API_KEY`** on the hook.
- Keys **without** stored plaintext and **without** a dedicated bearer cannot enable webhooks until one is configured.

`GET /api/account/keys` includes **`newsSignalsWebhookUrl`** (never returns bearer material).

### 3. Optional global webhook (single URL / ops / legacy)

If **`DRAFT_NEWS_SIGNALS_WEBHOOK_URL`** is set on the Engine host, Engine **also** POSTs once using **`INTERNAL_WEBHOOK_SECRET`** or **`AMETHYST_API_KEY`** as Bearer (same as before). Omit this when every tenant uses per–API-key URLs only.

Payload for every POST:

```json
{ "event": "signals_updated", "occurred_at": "<ISO8601>" }
```

Failures are logged only; they do not fail the signals response.

**Portal “Test webhook” (manual POST via `POST /api/account/keys/:id/news-signals-webhook/send`):**

Body is developer-supplied JSON; the portal sends:

```json
{
  "event": "custom",
  "message": "<text>",
  "source": "portal_test",
  "ephemeral": true
}
```

- **`source` / `ephemeral`:** Convention so Draft can render a **short-lived toast** (or ignore in analytics) instead of treating the payload like a durable in-room alert. Existing hooks that only read `event` + `message` remain valid.
- **Future draft-domain events (recommended plan, not shipped on Engine yet):** Push scarcity/monopoly-style signals only when the Draft host can correlate them to a **league + draft** (Engine valuation already computes `context_v2.position_alerts` and monopoly-style concentration in `analyzeScarcity`; exposing that over HTTP on every pick is heavy). A practical sequence:
  1. **Phase 1 — Draft-led:** Keep scarcity/monopoly UX driven by Draft’s existing valuation calls and Socket.IO; no new Engine webhook events until product agrees on frequency and payload size.
  2. **Phase 2 — Optional webhook fan-out:** Add Engine-originated events only if Draft registers interest (e.g. flag on key or separate URL), with throttling (e.g. at most one POST per league per N seconds per event family). Candidate shapes:
     - `{ "event": "draft_scarcity_shift", "league_id": "...", "occurred_at": "...", "positions": [ { "position": "SS", "urgency_score": 72, "severity": "high" } ] }` — subset of `context_v2.position_alerts`.
     - `{ "event": "draft_monopoly_shift", "league_id": "...", "occurred_at": "...", "warnings": [ { "category": "HR", "team_id": "...", "share_percentage": 42.1 } ] }` — mirrors monopoly warnings from scarcity analysis when Draft sends full `drafted_players` + scoring categories in valuation requests (Engine does not see live picks without that context).
  3. **Phase 3 — Idempotency:** Include `event_id` or content hash so Draft can dedupe if Engine retries.

Until Phase 2 exists, **`signals_updated`** remains the only automatic Engine→Draft webhook; scarcity/monopoly belong in **valuation responses** (`context_v2`) and Draft UI.

### 4. Engine env (global fallback only)

| Variable | Purpose |
|----------|---------|
| `DRAFT_NEWS_SIGNALS_WEBHOOK_URL` | Optional single webhook URL (legacy / instance-level). |
| `INTERNAL_WEBHOOK_SECRET` | Bearer for global URL when set. |
| `AMETHYST_API_KEY` | Bearer for global URL when `INTERNAL_WEBHOOK_SECRET` unset. |

**Last-Modified** was not implemented on Engine (optional).

---

## Draft behaviour (AmethystDraft repo)

| Piece | Behaviour |
|-------|-----------|
| `apps/api/src/realtime/newsSignalsPoller.ts` | Polls Engine `GET /signals/news` (7-day window). Sends `If-None-Match` from last `ETag` when present; treats `304` as unchanged (no Socket.IO emit). |
| `POST /api/internal/news-signals/hook` | Validates `Authorization: Bearer` vs `INTERNAL_WEBHOOK_SECRET` or `AMETHYST_API_KEY`, then forces a poll. Returns `503` only if neither env is set on Draft (Draft normally always has `AMETHYST_API_KEY`). |
| Browsers | Socket.IO event `news_signals_updated` when the poller detects a snapshot change (after `200` with new body). |

---

## Coordination checklist

1. **Per-app (recommended):** Each Draft deployment registers **`newsSignalsWebhookUrl`** (+ optional bearer) via **portal** for the API key their BFF uses. Bearer matches what their hook validates (often the same key as `x-api-key` to Engine).
2. **Global fallback:** Optional **`DRAFT_NEWS_SIGNALS_WEBHOOK_URL`** + env Bearer only if you still want one instance-level notify without Mongo registration.
3. **IP allowlisting:** If Draft sits behind a WAF / API gateway, allow Engine egress IPs (or private link / tunnel). Optional.
4. **Multi-instance Draft API:** Socket.IO fan-out across replicas may require Redis (pub/sub or adapter) — not automatic with multiple tasks yet.

### AWS App Runner (Engine)

Per-key URLs live in **MongoDB** (`apikeys`); no App Runner env needed for multi-tenant push. Optional global vars from section 4 above still apply if used.

---

## Original ask (historical)

Draft requested ETag/304 + webhook so singleton polls stay cheap and ingest can trigger fast fan-out. The contract above matches that intent.
