# Market ADP ingestion

Internal **`catalog_rank`** / **`catalog_tier`** describe preseason model ordering and dollar bands. **They are not market ADP.**

External consensus draft position lives only in **`market_adp`** (+ optional **`market_adp_*`** metadata) when populated from a **real vendor source**. Nothing in the valuation pipeline derives `market_adp` from `catalog_rank`.

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

Feature flag (informational): `AMETHYST_MARKET_ADP_ADAPTER=csv_fixture`.

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
