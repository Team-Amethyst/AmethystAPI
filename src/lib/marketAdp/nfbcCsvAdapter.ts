import { readFileSync } from "fs";
import type { MarketAdpAdapter, MarketAdpAdapterContext, MarketAdpVendorRow } from "./types";
import { parseCsvMatrix } from "./csvParse";

function parseNumberCell(raw: string): number | undefined {
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (cleaned === "") return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function parseIntCountCell(raw: string): number | undefined {
  const cleaned = raw.replace(/[,_\s]/g, "").trim();
  if (cleaned === "") return undefined;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

/** Normalize header labels for column detection. */
function normHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^#\s*/, "");
}

/**
 * NFBC / NFC style "Last, First" → "First Last" for downstream `normalizePlayerName` matching.
 */
export function normalizeNfbcListName(raw: string): string {
  const t = raw.trim();
  const m = /^([^,]+),\s*(.+)$/.exec(t);
  if (!m) return t;
  const last = m[1]!.trim();
  const first = m[2]!.trim();
  if (!first || !last) return t;
  return `${first} ${last}`;
}

function findColumnIndex(headers: string[], matchers: readonly string[]): number {
  const normalized = headers.map((h) => normHeader(h));
  for (const m of matchers) {
    const nm = normHeader(m);
    const i = normalized.indexOf(nm);
    if (i >= 0) return i;
  }
  for (const m of matchers) {
    const nm = normHeader(m);
    if (nm.length <= 2) continue;
    const j = normalized.findIndex((h) => h.includes(nm) || nm.includes(h));
    if (j >= 0) return j;
  }
  return -1;
}

function resolveNfbcColumnIndices(headers: string[]): {
  iPlayer: number;
  iTeam: number;
  iPos: number;
  iAdp: number;
  iMin: number;
  iMax: number;
  iPicks: number;
  iMlb: number;
} {
  const iPlayer = findColumnIndex(headers, ["player", "player name", "name"]);
  const iTeam = findColumnIndex(headers, ["team", "tm", "mlb team", "team abbrev"]);
  const iPos = findColumnIndex(headers, [
    "position(s)",
    "positions",
    "position",
    "pos",
    "eligible positions",
    "eligibility",
  ]);

  const headerNorm = headers.map((h) => normHeader(h));
  let iAdp = -1;
  const adpPriority = ["adp / aav", "adp/aav", "avg adp", "average draft position", "adp", "aav"];
  for (const key of adpPriority) {
    const idx = headerNorm.indexOf(key);
    if (idx >= 0) {
      iAdp = idx;
      break;
    }
  }
  if (iAdp < 0) {
    iAdp = headerNorm.findIndex((h) => h.includes("adp") || h.includes("aav"));
  }

  const iMin = findColumnIndex(headers, ["min"]);
  const iMax = findColumnIndex(headers, ["max"]);
  const iPicks = findColumnIndex(headers, [
    "# picks",
    "picks",
    "pick count",
    "# of picks",
    "no. of picks",
    "num picks",
  ]);
  const iMlb = findColumnIndex(headers, [
    "mlb id",
    "mlbid",
    "mlbam id",
    "mlbam",
    "mlbamid",
    "major league baseball id",
    "mlb player id",
  ]);

  return { iPlayer, iTeam, iPos, iAdp, iMin, iMax, iPicks, iMlb };
}

export function parseNfbcCsvMatrix(rows: string[][]): MarketAdpVendorRow[] {
  if (rows.length < 2) return [];

  const headers = rows[0]!;
  const { iPlayer, iTeam, iPos, iAdp, iMin, iMax, iPicks, iMlb } = resolveNfbcColumnIndices(headers);

  if (iPlayer < 0 || iTeam < 0 || iPos < 0 || iAdp < 0) {
    throw new Error(
      "NFBC CSV: missing required columns (need Player, Team, Position(s), and ADP/AAV). Found headers: " +
        headers.join(" | ")
    );
  }

  const out: MarketAdpVendorRow[] = [];

  for (let ri = 1; ri < rows.length; ri++) {
    const cols = rows[ri]!;
    const cell = (idx: number) => (idx >= 0 && cols[idx] !== undefined ? cols[idx]! : "");

    const nameRaw = normalizeNfbcListName(cell(iPlayer));
    const name = nameRaw.trim() || "Unknown";
    const team = cell(iTeam);
    const position = iPos >= 0 ? cell(iPos) : "";
    const adp = parseNumberCell(cell(iAdp));
    if (adp === undefined) continue;

    const mlbRaw = cell(iMlb);
    const mlb_id = mlbRaw && /^\d+$/.test(mlbRaw.replace(/\s/g, "")) ? Number(mlbRaw.replace(/\s/g, "")) : null;

    const adp_min = parseNumberCell(cell(iMin));
    const adp_max = parseNumberCell(cell(iMax));
    const sample_size = parseIntCountCell(cell(iPicks));

    out.push({
      mlb_id: mlb_id != null && mlb_id > 0 ? mlb_id : null,
      name,
      team,
      position,
      adp,
      adp_min: adp_min ?? null,
      adp_max: adp_max ?? null,
      sample_size: sample_size ?? null,
    });
  }

  return out;
}

export function parseNfbcCsvContent(content: string): MarketAdpVendorRow[] {
  return parseNfbcCsvMatrix(parseCsvMatrix(content));
}

/** CSV file adapter for NFBC/NFC-style ADP exports (no HTTP, no credentials). */
export function createNfbcCsvAdapter(csvPath: string): MarketAdpAdapter {
  return {
    id: "nfbc_csv",
    displayName: "NFBC",
    fetchRows: async (_ctx: MarketAdpAdapterContext) => {
      const text = readFileSync(csvPath, "utf8");
      return parseNfbcCsvContent(text);
    },
  };
}
