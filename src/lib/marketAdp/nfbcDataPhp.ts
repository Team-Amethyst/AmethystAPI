import type { MarketAdpAdapter, MarketAdpAdapterContext, MarketAdpVendorRow } from "./types";
import { normalizeTeamAbbrev } from "../catalogIdentityHelpers";
import { fetchNfbcCsvText, type CreateNfbcRemoteCsvAdapterOptions } from "./nfbcRemoteCsv";

/** Public NFBC ADP table endpoint (plain text rows). */
export const DEFAULT_NFBC_DATA_PHP_URL = "https://nfc.shgn.com/adp.data.php";

/**
 * Fantasy / NFBC vendor spellings → common catalog abbreviations (uppercase).
 * Applied before `normalizeTeamAbbrev`.
 */
const VENDOR_TEAM_TO_CATALOG: Record<string, string> = {
  ARZ: "ARI",
  MLW: "MIL",
  CWS: "CHW",
  ATH: "OAK",
  WAS: "WSH",
  WSN: "WSH",
};

/** Tokens that can appear as the team field in NFBC-style ADP rows (incl. common aliases). */
const KNOWN_MLB_STYLE_TEAM = new Set([
  "BAL",
  "BOS",
  "NYY",
  "TB",
  "TBR",
  "TOR",
  "CWS",
  "CHW",
  "CLE",
  "DET",
  "KC",
  "KCR",
  "MIN",
  "HOU",
  "LAA",
  "OAK",
  "ATH",
  "SEA",
  "TEX",
  "ATL",
  "MIA",
  "NYM",
  "PHI",
  "WSH",
  "WSN",
  "WAS",
  "CHC",
  "CIN",
  "MIL",
  "MLW",
  "PIT",
  "STL",
  "ARI",
  "ARZ",
  "AZ",
  "COL",
  "LAD",
  "SD",
  "SDP",
  "SF",
  "SFG",
]);

const TRAILING_NUMS_RE = /\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

/** Strip trailing comma from a position fragment (e.g. `UT,` → `UT`). */
function stripPosToken(raw: string): string {
  return raw.replace(/,/g, "").trim().toUpperCase();
}

const POSITION_TOKENS = new Set([
  "P",
  "SP",
  "RP",
  "C",
  "1B",
  "2B",
  "3B",
  "SS",
  "OF",
  "LF",
  "CF",
  "RF",
  "DH",
  "UT",
  "UTIL",
  "CI",
  "MI",
  "B",
]);

function isLikelyPositionToken(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  const core = stripPosToken(t);
  if (!core) return false;
  return POSITION_TOKENS.has(core);
}

export function normalizeNfbcDataPhpTeamAbbrev(raw: string): string {
  const u = raw.trim().toUpperCase();
  const mapped = VENDOR_TEAM_TO_CATALOG[u] ?? u;
  return normalizeTeamAbbrev(mapped);
}

export type NfbcDataPhpParseSkipped = {
  lineNumber: number;
  line: string;
  reason: string;
};

export type NfbcDataPhpParseResult = {
  rows: MarketAdpVendorRow[];
  skipped: NfbcDataPhpParseSkipped[];
};

function tdInnerVisible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * NFBC `adp.data.php` currently serves an HTML `<table>` fragment (not a whitespace-separated
 * text file). This parser only targets that known endpoint shape — not arbitrary web pages.
 */
export function parseNfbcDataPhpHtmlTable(html: string): MarketAdpVendorRow[] {
  const out: MarketAdpVendorRow[] = [];
  const trBlocks = html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi);
  for (const m of trBlocks) {
    const tr = m[0]!;
    if (!/class=["']rank["']/i.test(tr)) continue;

    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => tdInnerVisible(x[1]!));
    if (cells.length < 9) continue;

    const rank = Number.parseInt(cells[0]!, 10);
    const name = cells[1]!.trim();
    const teamRaw = cells[2]!.trim().toUpperCase();
    const position = cells[3]!.trim().replace(/\s*,\s*/g, ", ");
    const adp = Number(cells[4]!);
    const adpMin = Number(cells[5]!);
    const adpMax = Number(cells[6]!);
    const pickRaw = (cells[8] ?? cells[7] ?? "").trim().replace(/,/g, "");
    const pickCount = Number.parseInt(pickRaw, 10);

    if (!Number.isFinite(rank) || rank < 0 || !name) continue;
    if (!KNOWN_MLB_STYLE_TEAM.has(teamRaw)) continue;
    if (!Number.isFinite(adp) || adp <= 0) continue;
    if (!Number.isFinite(adpMin) || !Number.isFinite(adpMax)) continue;
    if (!Number.isFinite(pickCount) || pickCount < 1) continue;

    out.push({
      vendor_rank: Math.trunc(rank),
      name,
      team: normalizeNfbcDataPhpTeamAbbrev(teamRaw),
      position,
      adp,
      adp_min: adpMin,
      adp_max: adpMax,
      sample_size: pickCount,
      mlb_id: null,
    });
  }
  return out;
}

/** Line-oriented parser for whitespace-separated `adp.data.php`-style samples / fixtures. */
export function parseNfbcDataPhpPlainText(content: string): NfbcDataPhpParseResult {
  const rows: MarketAdpVendorRow[] = [];
  const skipped: NfbcDataPhpParseSkipped[] = [];
  const lines = content.split(/\r?\n/);

  for (let li = 0; li < lines.length; li++) {
    const lineNumber = li + 1;
    const line = lines[li]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parsed = parseNfbcDataPhpLine(trimmed);
    if (parsed.ok) {
      rows.push(parsed.row);
    } else {
      skipped.push({ lineNumber, line: trimmed, reason: parsed.reason });
    }
  }

  return { rows, skipped };
}

/**
 * Parse NFBC `adp.data.php` body: tries whitespace rows first, then the live HTML table layout.
 */
export function parseNfbcDataPhpText(content: string): NfbcDataPhpParseResult {
  const plain = parseNfbcDataPhpPlainText(content);
  if (plain.rows.length > 0) return plain;
  if (/<tr\b/i.test(content) && /class=["']rank["']/i.test(content)) {
    const htmlRows = parseNfbcDataPhpHtmlTable(content);
    if (htmlRows.length > 0) {
      return { rows: htmlRows, skipped: plain.skipped };
    }
  }
  return plain;
}

type ParseLineOk = { ok: true; row: MarketAdpVendorRow };
type ParseLineErr = { ok: false; reason: string };

export function parseNfbcDataPhpLine(trimmed: string): ParseLineOk | ParseLineErr {
  const m = TRAILING_NUMS_RE.exec(trimmed);
  if (!m) {
    return { ok: false, reason: "missing_trailing_adp_min_max_pick_count" };
  }

  const adp = Number(m[1]);
  const adpMin = Number(m[2]);
  const adpMax = Number(m[3]);
  const pickCount = Number(m[4]);
  if (!Number.isFinite(adp) || adp <= 0) {
    return { ok: false, reason: "invalid_adp" };
  }
  if (!Number.isFinite(adpMin) || !Number.isFinite(adpMax) || !Number.isFinite(pickCount)) {
    return { ok: false, reason: "invalid_min_max_or_pick_count" };
  }

  const head = trimmed.slice(0, m.index).trim();
  const parts = head.split(/\s+/);
  if (parts.length < 4) {
    return { ok: false, reason: "too_few_fields_before_adp" };
  }

  const rankRaw = parts[0]!;
  const rank = Number(rankRaw);
  if (!Number.isFinite(rank) || rank < 0 || String(Math.trunc(rank)) !== rankRaw) {
    return { ok: false, reason: "invalid_rank" };
  }

  const nameAndTeamParts = parts.slice(1);
  if (nameAndTeamParts.length < 2) {
    return { ok: false, reason: "missing_name_or_team" };
  }

  const posTokens: string[] = [];
  let i = nameAndTeamParts.length - 1;
  while (i >= 0 && isLikelyPositionToken(nameAndTeamParts[i]!)) {
    posTokens.unshift(nameAndTeamParts[i]!);
    i--;
  }
  if (posTokens.length === 0) {
    return { ok: false, reason: "no_position_tokens" };
  }

  const teamRaw = nameAndTeamParts[i];
  if (!teamRaw) {
    return { ok: false, reason: "missing_team" };
  }
  const teamUpper = teamRaw.trim().toUpperCase();
  if (!KNOWN_MLB_STYLE_TEAM.has(teamUpper)) {
    return { ok: false, reason: `unknown_team_token:${teamUpper}` };
  }

  const nameParts = nameAndTeamParts.slice(0, i);
  if (nameParts.length === 0) {
    return { ok: false, reason: "missing_player_name" };
  }

  const name = nameParts.join(" ").trim();
  if (!name) {
    return { ok: false, reason: "empty_player_name" };
  }

  const position = posTokens.join(" ").replace(/\s+,/g, ",").replace(/,\s+/g, ", ");
  const team = normalizeNfbcDataPhpTeamAbbrev(teamRaw);

  return {
    ok: true,
    row: {
      vendor_rank: Math.trunc(rank),
      name,
      team,
      position,
      adp,
      adp_min: adpMin,
      adp_max: adpMax,
      sample_size: Math.trunc(pickCount),
      mlb_id: null,
    },
  };
}

/** Resolve URL: CLI `--url` > `NFBC_ADP_URL` / `AMETHYST_NFBC_ADP_URL` > default data.php. */
export function resolveNfbcDataPhpUrl(cliUrl?: string): string {
  const fromCli = (cliUrl ?? "").trim();
  if (fromCli) return fromCli;
  const fromEnv = (process.env.NFBC_ADP_URL || process.env.AMETHYST_NFBC_ADP_URL || "").trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_NFBC_DATA_PHP_URL;
}

/** Dry-run: fetch NFBC `adp.data.php` (plain text) and parse rows (no Mongo writes). */
export function createNfbcDataPhpAdapter(
  urlString: string,
  options: CreateNfbcRemoteCsvAdapterOptions = {}
): MarketAdpAdapter {
  return {
    id: "nfbc_data_php",
    displayName: "NFBC",
    fetchRows: async (_ctx: MarketAdpAdapterContext) => {
      const text = await fetchNfbcCsvText(urlString, options);
      const parsed = parseNfbcDataPhpText(text);
      return parsed.rows;
    },
  };
}
