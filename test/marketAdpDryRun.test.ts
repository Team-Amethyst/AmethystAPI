import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  createCsvFixtureAdapter,
  dryRunMatchMarketAdp,
} from "../src/lib/marketAdp";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import type { LeanPlayer } from "../src/types/brain";

const ROOT = path.resolve(__dirname, "..");

describe("market ADP dry-run matching", () => {
  it("matches vendor rows by MLB id and produces proposed_updates without touching Mongo", async () => {
    const csvPath = path.join(ROOT, "test-fixtures/market-adp/sample-adp.csv");
    const adapter = createCsvFixtureAdapter(csvPath);
    const fetchedAt = "2026-05-10T12:00:00.000Z";
    const vendorRows = await adapter.fetchRows({
      sourceName: adapter.displayName,
      fetchedAt,
    });
    const raw = JSON.parse(
      readFileSync(path.join(ROOT, "test-fixtures/market-adp/catalog-sample.json"), "utf8")
    ) as unknown[];
    const catalog = normalizeCatalogPlayers(raw, () => undefined);

    const { matches, proposed_updates } = dryRunMatchMarketAdp(
      catalog,
      vendorRows,
      adapter.displayName,
      fetchedAt
    );

    expect(proposed_updates.length).toBe(3);
    expect(matches.filter((m) => m.kind === "matched")).toHaveLength(3);
    expect(matches.filter((m) => m.kind === "unmatched_vendor")).toHaveLength(1);

    const unmatched = matches.find(
      (m) => m.kind === "unmatched_vendor" && m.vendor.name === "Fake Player"
    );
    expect(unmatched).toBeDefined();

    const ambiguous = matches.filter((m) => m.kind === "ambiguous");
    expect(ambiguous).toHaveLength(0);
  });

  it("ambiguous vendor rows yield no proposed_updates for those rows", () => {
    const catalog: LeanPlayer[] = [
      {
        _id: "a",
        mlbId: 111,
        name: "Dup Player",
        team: "NYY",
        position: "OF",
        catalog_rank: 1,
        catalog_tier: 1,
        value: 10,
      },
      {
        _id: "b",
        mlbId: 111,
        name: "Dup Player",
        team: "NYY",
        position: "OF",
        catalog_rank: 2,
        catalog_tier: 1,
        value: 9,
      },
    ];
    const fetchedAt = "2026-05-10T12:00:00.000Z";
    const { matches, proposed_updates } = dryRunMatchMarketAdp(
      catalog,
      [
        {
          mlb_id: 111,
          name: "Dup Player",
          team: "NYY",
          position: "OF",
          adp: 12,
        },
      ],
      "unit-test",
      fetchedAt
    );
    expect(matches.some((m) => m.kind === "ambiguous")).toBe(true);
    expect(proposed_updates).toHaveLength(0);
  });
});
