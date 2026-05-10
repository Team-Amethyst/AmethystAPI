# News signals realtime — Engine ↔ Draft alignment

**Canonical Draft-side doc:** In **AmethystDraft**, see `apps/api/engine-contract/NEWS_SIGNALS_REALTIME_ENGINE_PROMPT.md` (same contract from the consumer / BFF perspective).

## Status

- **Draft** ships Socket.IO + singleton poll + `POST /api/internal/news-signals/hook`.
- **Engine (this repo)** ships conditional `GET /signals/news` (ETag / `If-None-Match` / `304`) + ingest webhook when MLB-backed snapshots change.

---

## Engine implementation summary

### 1. Conditional GET — ETag + 304

- **Validator:** SHA-256 hex of canonical JSON for `{ count, signals }` only (`fetched_at` excluded so the tag is stable).
- **Headers:** `ETag: "<64-char-hex>"` on `200` and `304`.
- **`If-None-Match`:** Parsed as quoted / unquoted and weak (`W/"..."`) — see `src/lib/signalsHttp.ts` (`ifNoneMatchIsCurrent`).
- **Fast path:** Redis sidecar `${signalsCacheKey}:http-etag` (TTL ≥ 24h while payload cache stays ~15m) can answer `304` without calling `fetchSignals` when the validator matches.
- **Second chance:** After `fetchSignals`, if the computed fingerprint matches `If-None-Match`, respond `304` (empty body).

### 2. Ingest → Draft BFF webhook

After a **cold MLB fetch**, Engine compares the new fingerprint to the previous value in Redis; **if it changed**, it `POST`s to **`DRAFT_NEWS_SIGNALS_WEBHOOK_URL`**:

```json
{ "event": "signals_updated", "occurred_at": "<ISO8601>" }
```

**`Authorization: Bearer …`** — Draft validates this token against **`INTERNAL_WEBHOOK_SECRET`** if set on Draft, **otherwise** **`AMETHYST_API_KEY`** (the same plaintext Draft uses as `x-api-key` to Engine). Easiest ops path: set **`AMETHYST_API_KEY`** on Engine and send `Bearer <AMETHYST_API_KEY>` — no extra Draft-only secret.

If the webhook URL is set but **neither** `INTERNAL_WEBHOOK_SECRET` nor `AMETHYST_API_KEY` is set on Engine, Engine logs a warning and **does not** send. Failures are logged only; they do not fail the signals response.

### 3. Engine env

| Variable | Purpose |
|----------|---------|
| `DRAFT_NEWS_SIGNALS_WEBHOOK_URL` | Full URL, e.g. `https://<draft-api-host>/api/internal/news-signals/hook` |
| `INTERNAL_WEBHOOK_SECRET` | Optional dedicated Bearer secret (must match Draft if used) |
| `AMETHYST_API_KEY` | Fallback Bearer value when `INTERNAL_WEBHOOK_SECRET` is unset; same key Draft uses as `x-api-key` to Engine |

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

1. **Bearer token:** Either **dedicated** `INTERNAL_WEBHOOK_SECRET` on **both** sides, or **reuse** `AMETHYST_API_KEY` as Bearer on Engine (matches Draft fallback validation).
2. **Webhook URL:** Engine `DRAFT_NEWS_SIGNALS_WEBHOOK_URL` = full Draft URL `https://<host>/api/internal/news-signals/hook` (HTTPS in prod).
3. **IP allowlisting:** If Draft sits behind a WAF / API gateway, allow Engine egress IPs (or private link / tunnel). Optional.
4. **Multi-instance Draft API:** Socket.IO fan-out across replicas may require Redis (pub/sub or adapter) — not automatic with multiple tasks yet.

### AWS App Runner (this Engine deployment)

Set environment variables on the **App Runner service** (Configuration → Environment variables). Values are **not** committed to git.

| Name | Notes |
|------|--------|
| `DRAFT_NEWS_SIGNALS_WEBHOOK_URL` | Full HTTPS URL to Draft’s hook, e.g. `https://<draft-api-host>/api/internal/news-signals/hook`. |
| `AMETHYST_API_KEY` | Same plaintext Draft uses as `x-api-key` when calling Engine — webhook Bearer uses this if `INTERNAL_WEBHOOK_SECRET` is unset. |
| `INTERNAL_WEBHOOK_SECRET` | Optional; if set on Engine **and** Draft, use this dedicated Bearer instead of the API key. |

Redeploy after changing variables (push to `main` triggers deploy in this repo’s workflow).

---

## Original ask (historical)

Draft requested ETag/304 + webhook so singleton polls stay cheap and ingest can trigger fast fan-out. The contract above matches that intent.
