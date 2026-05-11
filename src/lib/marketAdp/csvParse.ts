/**
 * Minimal RFC 4180–style CSV parsing for market ADP exports (quoted fields, commas in cells).
 */

function stripCell(raw: string): string {
  return raw.trim();
}

/** Split file into rows of trimmed string cells. Skips fully empty rows. */
export function parseCsvMatrix(content: string): string[][] {
  const text = content.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      if (row.some((c) => stripCell(c) !== "")) {
        rows.push(row.map(stripCell));
      }
      row = [];
      cell = "";
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  row.push(cell);
  if (row.some((c) => stripCell(c) !== "")) {
    rows.push(row.map(stripCell));
  }

  return rows;
}
