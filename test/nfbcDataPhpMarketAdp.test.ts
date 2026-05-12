import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  createNfbcDataPhpAdapter,
  dryRunMatchMarketAdp,
  normalizeNfbcDataPhpTeamAbbrev,
  parseNfbcDataPhpHtmlTable,
  parseNfbcDataPhpLine,
  parseNfbcDataPhpText,
  resolveNfbcDataPhpUrl,
} from "../src/lib/marketAdp";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";

const ROOT = path.resolve(__dirname, "..");

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/plain" }),
    text: async () => body,
  } as Response;
}

describe("NFBC adp.data.php parser", () => {
  it("parses a simple player line", () => {
    const r = parseNfbcDataPhpLine("2 Aaron Judge NYY OF 1.93 1 5 1640");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.vendor_rank).toBe(2);
    expect(r.row.name).toBe("Aaron Judge");
    expect(r.row.team).toBe("NYY");
    expect(r.row.position).toBe("OF");
    expect(r.row.adp).toBe(1.93);
    expect(r.row.adp_min).toBe(1);
    expect(r.row.adp_max).toBe(5);
    expect(r.row.sample_size).toBe(1640);
  });

  it("parses name with Jr.", () => {
    const r = parseNfbcDataPhpLine("3 Bobby Witt Jr. KC SS 3.18 1 6 1640");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.name).toBe("Bobby Witt Jr.");
    expect(r.row.team).toBe("KC");
    expect(r.row.position).toBe("SS");
  });

  it("parses multi-word name (De La Cruz)", () => {
    const r = parseNfbcDataPhpLine("4 Elly De La Cruz ARZ SS, 3B 12.5 5 20 500");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.name).toBe("Elly De La Cruz");
    expect(r.row.team).toBe("ARI");
    expect(r.row.position).toBe("SS, 3B");
  });

  it("parses multi-position UT, P", () => {
    const r = parseNfbcDataPhpLine("1 Shohei Ohtani LAD UT, P 1.20 1 4 1640");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.position).toBe("UT, P");
  });

  it("normalizes team alias MLW → MIL", () => {
    const r = parseNfbcDataPhpLine("5 Jazz Chisholm Jr. MLW 2B, 3B 55 40 70 1200");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.team).toBe("MIL");
  });

  it("rejects malformed rows", () => {
    expect(parseNfbcDataPhpLine("not enough fields").ok).toBe(false);
    expect(parseNfbcDataPhpLine("2.5 Bad Rank TOR OF 1 1 1 1").ok).toBe(false);
  });

  it("rejects unknown team token", () => {
    const r = parseNfbcDataPhpLine("9 Fake Player XXX OF 10 1 2 100");
    expect(r.ok).toBe(false);
  });

  it("parseNfbcDataPhpText skips bad lines and keeps good rows", () => {
    const txt = readFileSync(
      path.join(ROOT, "test-fixtures/market-adp/nfbc-data-php-sample.txt"),
      "utf8"
    );
    const { rows, skipped } = parseNfbcDataPhpText(txt);
    expect(rows.length).toBe(7);
    expect(skipped.length).toBeGreaterThanOrEqual(2);
  });

  it("parses NFBC HTML table fragment (live adp.data.php shape)", () => {
    const html = readFileSync(
      path.join(ROOT, "test-fixtures/market-adp/nfbc-data-php-table-snippet.html"),
      "utf8"
    );
    const rows = parseNfbcDataPhpHtmlTable(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe("Shohei Ohtani");
    expect(rows[0]?.team).toBe("LAD");
    expect(rows[0]?.position).toBe("UT, P");
    expect(rows[0]?.adp).toBe(1.2);
    expect(rows[0]?.sample_size).toBe(1640);
    expect(rows[1]?.name).toBe("Aaron Judge");

    const viaUnified = parseNfbcDataPhpText(html);
    expect(viaUnified.rows).toEqual(rows);
  });

  it("normalizeNfbcDataPhpTeamAbbrev maps vendor spellings", () => {
    expect(normalizeNfbcDataPhpTeamAbbrev("ARZ")).toBe("ARI");
    expect(normalizeNfbcDataPhpTeamAbbrev("MLW")).toBe("MIL");
    expect(normalizeNfbcDataPhpTeamAbbrev("CWS")).toBe("CHW");
    expect(normalizeNfbcDataPhpTeamAbbrev("ATH")).toBe("OAK");
    expect(normalizeNfbcDataPhpTeamAbbrev("WAS")).toBe("WSH");
    expect(normalizeNfbcDataPhpTeamAbbrev("WSN")).toBe("WSH");
  });

  it("resolveNfbcDataPhpUrl prefers CLI then env then default", () => {
    const prevA = process.env.NFBC_ADP_URL;
    const prevB = process.env.AMETHYST_NFBC_ADP_URL;
    try {
      delete process.env.NFBC_ADP_URL;
      delete process.env.AMETHYST_NFBC_ADP_URL;
      expect(resolveNfbcDataPhpUrl()).toMatch(/adp\.data\.php$/);
      process.env.NFBC_ADP_URL = "https://example.com/custom.php";
      expect(resolveNfbcDataPhpUrl()).toBe("https://example.com/custom.php");
      expect(resolveNfbcDataPhpUrl("https://override/cli")).toBe("https://override/cli");
    } finally {
      if (prevA === undefined) delete process.env.NFBC_ADP_URL;
      else process.env.NFBC_ADP_URL = prevA;
      if (prevB === undefined) delete process.env.AMETHYST_NFBC_ADP_URL;
      else process.env.AMETHYST_NFBC_ADP_URL = prevB;
    }
  });
});

describe("NFBC data.php dry-run", () => {
  it("matches fixture rows, flags ambiguous Dup Player, and leaves unknown unmatched", async () => {
    const body = readFileSync(
      path.join(ROOT, "test-fixtures/market-adp/nfbc-data-php-sample.txt"),
      "utf8"
    );
    const adapter = createNfbcDataPhpAdapter("https://example.com/adp.data.php", {
      fetchFn: vi.fn().mockResolvedValue(textResponse(body)),
    });
    const fetchedAt = "2026-05-11T12:00:00.000Z";
    const vendorRows = await adapter.fetchRows({
      sourceName: adapter.displayName,
      fetchedAt,
    });
    expect(adapter.id).toBe("nfbc_data_php");
    expect(adapter.displayName).toBe("NFBC");

    const raw = JSON.parse(
      readFileSync(path.join(ROOT, "test-fixtures/market-adp/catalog-nfbc-data-php-match.json"), "utf8")
    ) as unknown[];
    const catalog = normalizeCatalogPlayers(raw, () => undefined);

    const { matches, proposed_updates } = dryRunMatchMarketAdp(
      catalog,
      vendorRows,
      adapter.displayName,
      fetchedAt
    );

    expect(matches.filter((m) => m.kind === "matched")).toHaveLength(5);
    expect(matches.filter((m) => m.kind === "ambiguous")).toHaveLength(1);
    expect(matches.filter((m) => m.kind === "unmatched_vendor")).toHaveLength(1);

    expect(proposed_updates).toHaveLength(5);
    for (const u of proposed_updates) {
      expect(u.set.market_adp_source).toBe("NFBC");
      expect(u.set.market_adp_updated_at).toBe(fetchedAt);
      expect(u.set).toHaveProperty("market_adp_min");
      expect(u.set).toHaveProperty("market_adp_max");
      expect(u.set).toHaveProperty("market_pick_count");
    }

    const amb = matches.find((m) => m.kind === "ambiguous");
    expect(amb?.kind).toBe("ambiguous");
    if (amb?.kind === "ambiguous") expect(amb.vendor.name).toBe("Dup Player");

    const unmatched = matches.find((m) => m.kind === "unmatched_vendor");
    expect(unmatched?.kind).toBe("unmatched_vendor");
    if (unmatched?.kind === "unmatched_vendor") {
      expect(unmatched.vendor.name).toBe("No Catalog Player Here");
    }
  });
});
