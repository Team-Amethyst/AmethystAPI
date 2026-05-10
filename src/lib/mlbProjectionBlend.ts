/**
 * Weighted multi-year projection from MLB season stat records (5:3:2 most-recent → oldest).
 * Mirrors the product contract used elsewhere in Amethyst: same minimum sample rules per year.
 */

export type MlbStatRecord = Record<string, string | number | undefined>;

const W = [5, 3, 2] as const;

/**
 * MLB Stats API `stats=season&group=pitching` splits omit `qualityStarts` on many feeds.
 * When missing/zero, derive a conservative season-level QS count from GS / IP / ER so
 * catalog rows persist `projection.pitching.qualityStarts` for QS scoring modes.
 */
export function estimateQualityStartsFromSeasonAggregate(stat: MlbStatRecord): number {
  const direct = num(stat.qualityStarts);
  if (direct > 0) return Math.round(direct);
  const gs = num(stat.gamesStarted);
  if (gs <= 0) return 0;
  const ip = num(stat.inningsPitched);
  const er = num(stat.earnedRuns);
  const ipPerStart = ip / gs;
  const erPerStart = er / gs;
  /** Rough QS rate from average outing shape (QS = 6+ IP, ≤3 ER per start). */
  let rate = 0;
  if (ipPerStart >= 6 && erPerStart <= 3) rate = 0.72;
  else if (ipPerStart >= 5.5 && erPerStart <= 3.5) rate = 0.5;
  else if (ipPerStart >= 5 && erPerStart <= 4.5) rate = 0.32;
  else if (ipPerStart >= 4.5 && erPerStart <= 5) rate = 0.15;
  else if (ipPerStart >= 4) rate = 0.06;
  return Math.max(0, Math.min(gs, Math.round(gs * rate)));
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** A year counts for hitting when AB ≥ minAb. */
function parseRateStat(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const x = parseFloat(v.trim());
    if (Number.isFinite(x)) return x;
  }
  return null;
}

export function projectBatting(
  yr1?: MlbStatRecord | null,
  yr2?: MlbStatRecord | null,
  yr3?: MlbStatRecord | null,
  minAb = 50
): {
  avg: string;
  hr: number;
  rbi: number;
  runs: number;
  sb: number;
  atBats: number;
  obp: string;
  plateAppearances: number;
  slg: string;
  ops: string;
  totalBases: number;
} | null {
  const years = [yr1, yr2, yr3];
  let wTotal = 0;
  let wH = 0;
  let wAB = 0;
  let wHR = 0;
  let wRBI = 0;
  let wRuns = 0;
  let wSB = 0;
  let wPA = 0;
  let wObpPa = 0;
  let wTB = 0;
  let wOpsPa = 0;

  for (let i = 0; i < years.length; i++) {
    const s = years[i];
    if (!s) continue;
    const ab = num(s.atBats);
    if (ab < minAb) continue;
    const w = W[i] ?? 1;
    wTotal += w;
    wAB += ab * w;
    wH += num(s.hits) * w;
    wHR += num(s.homeRuns) * w;
    wRBI += num(s.rbi) * w;
    wRuns += num(s.runs) * w;
    wSB += num(s.stolenBases) * w;
    const bb = num(s.baseOnBalls);
    const pa =
      num(s.plateAppearances) > 0
        ? num(s.plateAppearances)
        : ab + bb + num(s.hitByPitch) + num(s.sacFlies);
    const obpStr = String(s.obp ?? "").trim();
    const obpParse = Number(obpStr);
    const obp =
      Number.isFinite(obpParse) && obpParse > 0
        ? obpParse
        : pa > 0
          ? (num(s.hits) + bb) / pa
          : 0;
    wPA += pa * w;
    wObpPa += obp * pa * w;
    wTB += num(s.totalBases) * w;

    const opsDirect = parseRateStat(s.ops);
    const slgDirect = parseRateStat(s.slg);
    const slgEst =
      slgDirect ??
      (ab > 0 ? num(s.totalBases) / ab : null);
    const obpNum =
      Number.isFinite(obpParse) && obpParse > 0 ? obpParse : pa > 0 ? obp : 0;
    const opsNum =
      opsDirect ??
      (slgEst != null && Number.isFinite(obpNum) ? obpNum + slgEst : null);
    if (opsNum != null && Number.isFinite(opsNum)) {
      wOpsPa += opsNum * pa * w;
    }
  }

  if (wTotal <= 0 || wAB <= 0) return null;

  const avg = wH / wAB;
  const blendedPa = wPA / wTotal;
  const blendedObp = wPA > 0 ? wObpPa / wPA : 0;
  const blendedTb = wTB / wTotal;
  const slgNum = blendedTb / (wAB / wTotal);
  const opsNum =
    wPA > 0 && wOpsPa > 0 ? wOpsPa / wPA : blendedObp + slgNum;

  return {
    avg: avg.toFixed(3),
    hr: Math.round(wHR / wTotal),
    rbi: Math.round(wRBI / wTotal),
    runs: Math.round(wRuns / wTotal),
    sb: Math.round(wSB / wTotal),
    atBats: Math.round(wAB / wTotal),
    obp: blendedObp.toFixed(3),
    plateAppearances: Math.max(0, Math.round(blendedPa)),
    slg: Number.isFinite(slgNum) ? slgNum.toFixed(3) : ".000",
    ops: Number.isFinite(opsNum) ? opsNum.toFixed(3) : ".000",
    totalBases: Math.max(0, Math.round(blendedTb)),
  };
}

/** A year counts for pitching when IP ≥ minIp or saves ≥ minSv. */
export function projectPitching(
  yr1?: MlbStatRecord | null,
  yr2?: MlbStatRecord | null,
  yr3?: MlbStatRecord | null,
  minIp = 15,
  minSv = 3
): {
  era: string;
  whip: string;
  wins: number;
  saves: number;
  strikeouts: number;
  innings: string;
  holds: number;
  qualityStarts: number;
} | null {
  const years = [yr1, yr2, yr3];
  let wTotal = 0;
  let wIP = 0;
  let wER = 0;
  let wBR = 0;
  let wW = 0;
  let wSV = 0;
  let wK = 0;
  let wHolds = 0;
  let wQS = 0;

  for (let i = 0; i < years.length; i++) {
    const s = years[i];
    if (!s) continue;
    const ip = num(s.inningsPitched);
    const sv = num(s.saves);
    if (ip < minIp && sv < minSv) continue;
    const w = W[i] ?? 1;
    wTotal += w;
    wIP += ip * w;
    wER += num(s.earnedRuns) * w;
    wBR += (num(s.hits) + num(s.baseOnBalls)) * w;
    wW += num(s.wins) * w;
    wSV += sv * w;
    wK += num(s.strikeOuts) * w;
    wHolds += num(s.holds) * w;
    const qsY =
      num(s.qualityStarts) > 0
        ? num(s.qualityStarts)
        : estimateQualityStartsFromSeasonAggregate(s);
    wQS += qsY * w;
  }

  if (wTotal <= 0 || wIP <= 0) return null;

  const era = (wER / wIP) * 9;
  const whip = wBR / wIP;
  return {
    era: era.toFixed(2),
    whip: whip.toFixed(2),
    wins: Math.round(wW / wTotal),
    saves: Math.round(wSV / wTotal),
    strikeouts: Math.round(wK / wTotal),
    innings: (wIP / wTotal).toFixed(1),
    holds: Math.round(wHolds / wTotal),
    qualityStarts: Math.round(wQS / wTotal),
  };
}

/**
 * Fills missing expanded scoring fields on `projection` from the anchor season stat line
 * (sync uses the most recent blended year for tie-break). Does not overwrite non-empty
 * blended strings/numbers — only sets keys that are `undefined` or `""`.
 */
export function applyAnchorYearProjectionEnrichment(
  projection: Record<string, unknown>,
  anchorBat?: Record<string, string | number> | null,
  anchorPit?: Record<string, string | number> | null
): void {
  if (projection.batting && anchorBat) {
    fillBattingGapsFromRawStat(
      projection.batting as Record<string, unknown>,
      anchorBat
    );
  }
  if (projection.pitching && anchorPit) {
    fillPitchingGapsFromRawStat(
      projection.pitching as Record<string, unknown>,
      anchorPit
    );
  }
}

function fillBattingGapsFromRawStat(
  b: Record<string, unknown>,
  stat: Record<string, string | number>
): void {
  const ab = num(stat.atBats);
  const tb = num(stat.totalBases);
  const slgDirect = parseRateStat(stat.slg);
  const slgNum =
    slgDirect != null && slgDirect > 0 ? slgDirect : ab > 0 ? tb / ab : 0;
  const obpStr = String(stat.obp ?? ".000");
  const obpNum = parseFloat(obpStr);
  const opsDirect = parseRateStat(stat.ops);
  const opsNum =
    opsDirect != null && opsDirect > 0
      ? opsDirect
      : Number.isFinite(obpNum) && Number.isFinite(slgNum)
        ? obpNum + slgNum
        : 0;

  if (b.slg === undefined || b.slg === "") {
    b.slg = Number.isFinite(slgNum) ? slgNum.toFixed(3) : ".000";
  }
  if (b.ops === undefined || b.ops === "") {
    b.ops = Number.isFinite(opsNum) ? opsNum.toFixed(3) : ".000";
  }
  if (b.totalBases === undefined) {
    b.totalBases = Math.max(0, Math.round(tb));
  }
}

function fillPitchingGapsFromRawStat(
  p: Record<string, unknown>,
  stat: Record<string, string | number>
): void {
  if (p.holds === undefined) {
    p.holds = num(stat.holds);
  }
  if (p.qualityStarts === undefined) {
    p.qualityStarts = estimateQualityStartsFromSeasonAggregate(stat as MlbStatRecord);
  }
}
