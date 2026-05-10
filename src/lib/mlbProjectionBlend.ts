/**
 * Weighted multi-year projection from MLB season stat records (5:3:2 most-recent → oldest).
 * Mirrors the product contract used elsewhere in Amethyst: same minimum sample rules per year.
 */

export type MlbStatRecord = Record<string, string | number | undefined>;

const W = [5, 3, 2] as const;

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
    wQS += num(s.qualityStarts) * w;
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
