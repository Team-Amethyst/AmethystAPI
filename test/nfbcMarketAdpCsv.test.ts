import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  createNfbcCsvAdapter,
  dryRunMatchMarketAdp,
  normalizeNfbcListName,
  parseCsvMatrix,
  parseNfbcCsvContent,
} from "../src/lib/marketAdp";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";

const ROOT = path.resolve(__dirname, "..");

describe("NFBC market ADP CSV", () => {
  it("parses quoted cells with embedded commas", () => {
    const m = parseCsvMatrix('Player,Team\n"Acuna Jr., Ronald",ATL\n');
    expect(m).toEqual([
      ["Player", "Team"],
      ["Acuna Jr., Ronald", "ATL"],
    ]);
  });

  it("normalizeNfbcListName flips Last, First", () => {
    expect(normalizeNfbcListName("Judge, Aaron")).toBe("Aaron Judge");
    expect(normalizeNfbcListName("Shohei Ohtani")).toBe("Shohei Ohtani");
  });

  it("maps NFBC-like headers and numeric cleanup", async () => {
    const csvPath = path.join(ROOT, "test-fixtures/market-adp/nfbc-like-adp.csv");
    const content = readFileSync(csvPath, "utf8");
    const rows = parseNfbcCsvContent(content);
    expect(rows.length).toBe(5);
    const judge = rows.find((r) => r.name === "Aaron Judge");
    expect(judge?.mlb_id).toBe(592450);
    expect(judge?.adp).toBe(4.1);
    expect(judge?.sample_size).toBe(1480);
    const ronald = rows.find((r) => r.name === "Ronald Acuna Jr.");
    expect(ronald?.sample_size).toBe(1400);
  });

  it("dry-run matches MLB id, list names, multi-position, and labels source NFBC", async () => {
    const csvPath = path.join(ROOT, "test-fixtures/market-adp/nfbc-like-adp.csv");
    const adapter = createNfbcCsvAdapter(csvPath);
    const fetchedAt = "2026-05-10T12:00:00.000Z";
    const vendorRows = await adapter.fetchRows({
      sourceName: adapter.displayName,
      fetchedAt,
    });
    const raw = JSON.parse(
      readFileSync(path.join(ROOT, "test-fixtures/market-adp/catalog-nfbc-match.json"), "utf8")
    ) as unknown[];
    const catalog = normalizeCatalogPlayers(raw, () => undefined);

    const { matches, proposed_updates } = dryRunMatchMarketAdp(
      catalog,
      vendorRows,
      adapter.displayName,
      fetchedAt
    );

    expect(matches.filter((m) => m.kind === "matched")).toHaveLength(4);
    expect(matches.filter((m) => m.kind === "unmatched_vendor")).toHaveLength(1);
    expect(matches.filter((m) => m.kind === "ambiguous")).toHaveLength(0);

    expect(proposed_updates).toHaveLength(4);
    for (const u of proposed_updates) {
      expect(u.set.market_adp_source).toBe("NFBC");
      expect(u.set.market_adp_updated_at).toBe(fetchedAt);
    }

    const muncy = proposed_updates.find((u) => u.mlb_id === 570592);
    expect(muncy?.set.market_adp).toBe(45);
    expect(muncy?.set.market_pick_count).toBe(800);
  });
});
