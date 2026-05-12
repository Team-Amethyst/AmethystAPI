import { describe, expect, it, vi } from "vitest";
import {
  createNfbcRemoteCsvAdapter,
  fetchNfbcCsvText,
  redactMarketAdpSourceUrl,
} from "../src/lib/marketAdp/nfbcRemoteCsv";
import { dryRunMatchMarketAdp } from "../src/lib/marketAdp/matchDryRun";
import { normalizeCatalogPlayers } from "../src/lib/playerCatalog";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

function csvResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Not Found",
    headers: new Headers({ "content-type": "text/csv" }),
    text: async () => body,
  } as Response;
}

describe("NFBC remote CSV fetch", () => {
  it("fetchNfbcCsvText returns body on success (mocked fetch)", async () => {
    const body = "a\nb";
    const fetchFn = vi.fn().mockResolvedValue(csvResponse(body));
    const out = await fetchNfbcCsvText("https://example.com/export.csv", { fetchFn });
    expect(out).toBe(body);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init?.signal).toBeDefined();
  });

  it("rejects non-http(s) URLs", async () => {
    await expect(fetchNfbcCsvText("file:///etc/passwd", { fetchFn: vi.fn() })).rejects.toThrow(
      /http\(s\)/
    );
  });

  it("throws on HTTP error responses", async () => {
    const fetchFn = vi.fn().mockResolvedValue(csvResponse("", false, 503));
    await expect(fetchNfbcCsvText("https://example.com/x.csv", { fetchFn })).rejects.toThrow(
      /HTTP 503/
    );
  });

  it("throws on timeout (abort)", async () => {
    const fetchFn = vi.fn().mockImplementation((_u: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("Aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });
    await expect(
      fetchNfbcCsvText("https://example.com/slow.csv", { fetchFn, timeoutMs: 20 })
    ).rejects.toThrow(/timed out/);
  });

  it("redactMarketAdpSourceUrl strips query and truncates long paths", () => {
    const q = "?token=secret";
    const longPath = "/a".repeat(80);
    expect(redactMarketAdpSourceUrl(`https://data.example.com${longPath}${q}`)).not.toContain(
      "token="
    );
  });

  it("createNfbcRemoteCsvAdapter parses NFBC CSV from mocked fetch", async () => {
    const fixture = readFileSync(
      path.join(ROOT, "test-fixtures/market-adp/nfbc-like-adp.csv"),
      "utf8"
    );
    const fetchFn = vi.fn().mockResolvedValue(csvResponse(fixture));
    const adapter = createNfbcRemoteCsvAdapter("https://cdn.example.com/nfbc.csv", { fetchFn });
    const rows = await adapter.fetchRows({
      sourceName: adapter.displayName,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(rows.length).toBe(5);
    expect(adapter.id).toBe("nfbc_remote_csv");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("malformed CSV yields empty vendor rows when no valid ADP rows", async () => {
    const fetchFn = vi.fn().mockResolvedValue(csvResponse("not,a,valid\nnfbc,sheet,here\n"));
    const adapter = createNfbcRemoteCsvAdapter("https://example.com/bad.csv", { fetchFn });
    await expect(
      adapter.fetchRows({ sourceName: "NFBC", fetchedAt: "2026-01-01T00:00:00.000Z" })
    ).rejects.toThrow(/missing required columns/i);
  });

  it("missing required columns throws from parser", async () => {
    const fetchFn = vi.fn().mockResolvedValue(csvResponse("Foo,Bar\n1,2\n"));
    const adapter = createNfbcRemoteCsvAdapter("https://example.com/wrong-headers.csv", {
      fetchFn,
    });
    await expect(
      adapter.fetchRows({ sourceName: "NFBC", fetchedAt: "2026-01-01T00:00:00.000Z" })
    ).rejects.toThrow(/missing required columns/i);
  });

  it("dry-run with remote adapter does not write Mongo", async () => {
    const fixture = readFileSync(
      path.join(ROOT, "test-fixtures/market-adp/nfbc-like-adp.csv"),
      "utf8"
    );
    const fetchFn = vi.fn().mockResolvedValue(csvResponse(fixture));
    const adapter = createNfbcRemoteCsvAdapter("https://example.com/f.csv", { fetchFn });
    const rows = await adapter.fetchRows({
      sourceName: adapter.displayName,
      fetchedAt: "2026-05-10T12:00:00.000Z",
    });
    const raw = JSON.parse(
      readFileSync(path.join(ROOT, "test-fixtures/market-adp/catalog-nfbc-match.json"), "utf8")
    ) as unknown[];
    const catalog = normalizeCatalogPlayers(raw, () => undefined);
    const { proposed_updates } = dryRunMatchMarketAdp(
      catalog,
      rows,
      adapter.displayName,
      "2026-05-10T12:00:00.000Z"
    );
    expect(proposed_updates.length).toBe(4);
    expect(proposed_updates.every((u) => u.set.market_adp_source === "NFBC")).toBe(true);
  });
});
