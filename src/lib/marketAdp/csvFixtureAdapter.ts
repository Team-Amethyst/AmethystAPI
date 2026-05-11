import { readFileSync } from "fs";
import type { MarketAdpAdapter, MarketAdpAdapterContext, MarketAdpVendorRow } from "./types";
import { parseCsvMatrix } from "./csvParse";

function parseNumberCell(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function parseCsv(content: string): MarketAdpVendorRow[] {
  const matrix = parseCsvMatrix(content);
  if (matrix.length < 2) return [];

  const header = matrix[0]!.map((h) => h.trim().toLowerCase());
  const col = (names: string[]): number => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iMlb = col(["mlb_id", "mlbid"]);
  const iName = col(["name", "player"]);
  const iTeam = col(["team"]);
  const iPos = col(["position", "pos", "position(s)"]);
  const iAdp = col(["adp", "adp / aav", "adp/aav"]);
  const iMin = col(["adp_min", "min"]);
  const iMax = col(["adp_max", "max"]);
  const iPick = col(["pick_count", "sample_size", "# picks", "picks"]);

  const rows: MarketAdpVendorRow[] = [];

  for (let li = 1; li < matrix.length; li++) {
    const cols = matrix[li]!;
    const cell = (idx: number) => (idx >= 0 && cols[idx] !== undefined ? cols[idx]! : "");

    const mlbRaw = cell(iMlb);
    const mlb_id =
      mlbRaw && /^\d+$/.test(mlbRaw) ? Number(mlbRaw) : null;
    const name = cell(iName) || "Unknown";
    const team = cell(iTeam);
    const position = cell(iPos);
    const adp = parseNumberCell(cell(iAdp));
    if (adp === undefined) continue;

    const adp_min = parseNumberCell(cell(iMin));
    const adp_max = parseNumberCell(cell(iMax));
    const sample_size = parseNumberCell(cell(iPick));

    rows.push({
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

  return rows;
}

export function createCsvFixtureAdapter(csvPath: string): MarketAdpAdapter {
  return {
    id: "csv_fixture",
    displayName: `CSV fixture (${csvPath})`,
    fetchRows: async (_ctx: MarketAdpAdapterContext) => {
      const text = readFileSync(csvPath, "utf8");
      return parseCsv(text);
    },
  };
}
