# Market ADP ingestion

Internal **`catalog_rank`** / **`catalog_tier`** describe preseason model ordering and dollar bands. **They are not market ADP.**

External consensus draft position lives only in **`market_adp`** (+ optional **`market_adp_*`** metadata) when populated from a **real vendor source**. Nothing in the valuation pipeline derives `market_adp` from `catalog_rank`.

## Valuation policy: `market_adp` is context, not an `auction_value` input

Ingested **`market_adp`** is for **response context** (labels, comparisons, explainability) and operator workflows — **not** to move **`auction_value`**, which stays **surplus-based model fair value** only. **Do not** blend **`market_adp`** into **`auction_value`** without a separate policy pass, tuning, and budget rescaling; naive mixes with **`recommended_bid`** blow aggregate dollars vs the surplus identity. **Live draft / max bid** UX should continue to treat **`recommended_bid`** as the bid anchor that may sit above model **`auction_value`**. Full ladder and rationale: [valuation-dollar-ladder.md](valuation-dollar-ladder.md) (section **Market ADP vs `auction_value` (policy)**).

## Adapter interface

Code: `MarketAdpAdapter` in `src/lib/marketAdp/types.ts`.

- **`id`**, **`displayName`** — stable identifier and human label.
- **`fetchRows(ctx)`** — returns normalized `MarketAdpVendorRow[]` (`mlb_id`, `name`, `team`, `position`, `adp`, optional min/max/sample).
- Matching is **dry-run** only via `dryRunMatchMarketAdp` (`src/lib/marketAdp/matchDryRun.ts`): MLB id first, then exact name+team+position, then looser name/team/position pass. No Mongo writes.

Validation schema for vendor rows: `src/lib/marketAdpVendorRowZod.ts`.

## Source comparison (first implementation)

| Source | Access | Format stability | MLB ids | Terms risk |
|--------|--------|------------------|---------|------------|
| **CSV export (fixture)** | Local file | Depends on export | Often absent → name/team/pos match | Low (your file) |
| **FantasyPros composite** | API / export | Moderate | Rarely native MLB id | API ToS + key |
| **NFBC / NFC** | Often login-gated exports | Good for NFBC leagues | Sometimes in exports | Membership / redistribution |
| **Yahoo public ADP** | Scraping / undocumented APIs | Breakage risk | No | ToS / scraping |
| **RotoWire** | Mixed (often subscriber) | Variable | No | Subscriber terms |

### Recommendation

1. **Ship `csv_fixture` adapter first** (`createCsvFixtureAdapter`): operators drop an NFBC/FantasyPros CSV into `tmp/` or CI fixtures; dry-run produces `tmp/market-adp-ingest-preview.json` with matched / ambiguous / unmatched rows. **No Mongo writes** until an explicit apply step is approved.
2. **Next**: a **FantasyPros** (or vendor-approved) **HTTP adapter** behind env-configured API key and documented refresh cadence, only after reviewing current terms of use.

Do **not** scrape sources behind login or commit credentials.

## Dry-run preview script

```bash
pnpm run market-adp-preview
```

Or explicitly:

```bash
pnpm exec ts-node --project tsconfig.scripts.json scripts/market-adp-ingest-preview.ts \
  --csv test-fixtures/market-adp/sample-adp.csv \
  --catalog-json test-fixtures/market-adp/catalog-sample.json \
  --out tmp/market-adp-ingest-preview.json
```

Optional catalog from Mongo: `--mongo` (requires `MONGO_URI`). Still **no writes**.

Feature flag (informational): `AMETHYST_MARKET_ADP_ADAPTER` may reflect `csv_fixture`, `nfbc_csv`, `nfbc_remote_csv`, or `nfbc_data_php`.

## NFBC `adp.data.php` (automated)

`pnpm market-adp-preview -- --source nfbc-data` fetches **`https://nfc.shgn.com/adp.data.php`** by default (override with `--url` or `NFBC_ADP_URL` / `AMETHYST_NFBC_ADP_URL`). The response is parsed as **whitespace rows** (fixtures / samples) or, when those yield no rows, as the **known HTML `<tr>` table** shape returned by the live endpoint — not arbitrary site scraping.

## NFBC remote CSV (automated URL)

Use a **direct HTTPS URL** to an NFBC-shaped CSV you are allowed to pull (e.g. object storage signed URL, internal CDN, automation drop). **Do not** point at HTML login pages or scrape behind authentication.

### Where the CSV should live

- **Production-style:** HTTPS host you control or vendor-approved storage, returning `text/csv` or `text/plain` with NFBC-like columns.
- **Local debugging:** Any HTTP(S) server that serves the file; for a **fixture-equivalent** dry-run without a second process, run:
  - `pnpm run market-adp-preview:remote-selftest`  
  This starts a short-lived localhost server **in the same Node process** as `fetch`, writes `tmp/nfbc-remote-preview.json`, and exits (no Mongo writes).

### Required / optional env vars

| Variable | Purpose |
|----------|---------|
| `NFBC_ADP_URL` or `AMETHYST_NFBC_ADP_URL` | Default CSV URL when `--source nfbc` and neither `--csv` nor `--url` is passed. |
| `NFBC_ADP_BEARER_TOKEN` | Optional; sets `Authorization: Bearer …` (never commit). |
| `NFBC_ADP_AUTHORIZATION` | Optional; full `Authorization` header value if not Bearer. |
| `NFBC_ADP_FETCH_TIMEOUT_MS` | Optional; default timeout for GET (ms). |

### How to run dry-run (remote)

```bash
export NFBC_ADP_URL='https://example.com/path/to/nfbc-export.csv?signature=…'
pnpm market-adp-preview -- --source nfbc --url "$NFBC_ADP_URL" --out tmp/nfbc-remote-preview.json
```

With catalog JSON (recommended before Mongo apply):

```bash
pnpm market-adp-preview -- \
  --source nfbc \
  --url "$NFBC_ADP_URL" \
  --catalog-json path/to/catalog.json \
  --out tmp/nfbc-remote-preview.json
```

Preview JSON includes:

- `adapter_id`: `nfbc_remote_csv` when using `--url` / env URL.
- `csv_path`: `null` for remote pulls.
- `remote_csv_url_redacted`: **origin + pathname only** (query string stripped so secrets in `?…` are not persisted).
- `stats`: `vendor_rows`, `matched`, `ambiguous`, `unmatched_vendor`, `proposed_update_count`.

### How to inspect unmatched / ambiguous rows

- Open `tmp/nfbc-remote-preview.json` (or your `--out` path).
- **`matches`**: entries with `kind: "unmatched_vendor"` include `vendor` + `reason`; `kind: "ambiguous"` include `candidate_player_ids`.
- Fix catalog gaps or vendor column issues, then re-run dry-run.

### What makes a preview “acceptable” (threshold)

Tune per league, but a reasonable bar before any **apply** step:

- **Match rate:** high share of `matched / vendor_rows` (e.g. ≥ **95%** for production catalogs once NFBC export is aligned).
- **Ambiguous:** **0** ambiguous rows, or each resolved manually (duplicate identities in catalog).
- **Unmatched:** only expected gaps (prospects not in catalog, retired players, name/team mismatches) with documented reasons.
- **Proposed IDs:** `player_id` values should be **canonical MLB numeric ids** for rows that have `mlbId` in catalog; investigate any 24-hex ObjectId-style ids before apply.
- **Metadata:** every proposed row has `market_adp_source: "NFBC"` and a consistent `market_adp_updated_at` for the run.

## Rank / tier field map (API)

| Field | Meaning |
|-------|---------|
| `catalog_rank` | Internal rank by catalog/preseason value |
| `catalog_tier` | Internal catalog value tier |
| `auction_rank` | Rank by `auction_value` within this response’s `valuations[]` |
| `auction_tier` | Tier from `auction_value` distribution within this response |
| `baseline_rank` | Rank by `baseline_value` within this response |
| `baseline_tier` | Tier from `baseline_value` distribution within this response |
| `market_adp` | External ADP only (optional) |
| `market_adp_source`, `market_adp_updated_at`, `market_adp_min`, `market_adp_max`, `market_pick_count` | Optional vendor metadata |
