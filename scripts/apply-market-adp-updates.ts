/**
 * Plan or apply Mongo updates for market ADP fields from a `market-adp-ingest-preview` JSON file.
 *
 * Default: dry-run only (no Mongo writes).
 * Real writes: `--apply` plus `MARKET_ADP_APPLY_CONFIRM=YES`.
 *
 * Usage:
 *   pnpm market-adp-apply -- --preview tmp/nfbc-data-mongo-preview.json
 *   MARKET_ADP_APPLY_CONFIRM=YES pnpm market-adp-apply -- --preview tmp/nfbc-data-mongo-preview.json --apply
 */
import dotenv from "dotenv";
import { runMarketAdpApplyCli } from "../src/lib/marketAdp/runMarketAdpApplyCli";

dotenv.config();

if (require.main === module) {
  runMarketAdpApplyCli(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
