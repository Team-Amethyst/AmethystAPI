/**
 * Pure transforms used by `scripts/sync-players.ts` when normalizing MLB Stats API
 * season stat splits into Engine `Player` documents. Covered by unit tests.
 */

export function calcAge(birthDate?: string): number {
  if (!birthDate) return 0;
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

export function assignTier(value: number): number {
  if (value >= 40) return 1;
  if (value >= 25) return 2;
  if (value >= 15) return 3;
  if (value >= 5) return 4;
  return 5;
}

export function calcBatterValue(stat: Record<string, string | number>): number {
  const hr = Number(stat.homeRuns ?? 0);
  const rbi = Number(stat.rbi ?? 0);
  const runs = Number(stat.runs ?? 0);
  const sb = Number(stat.stolenBases ?? 0);
  const avg = parseFloat(String(stat.avg ?? "0"));
  const ab = Number(stat.atBats ?? 0);
  if (ab < 100) return 0;
  const score =
    (hr - 18) * 2.8 +
    (rbi - 72) * 0.9 +
    (runs - 72) * 0.9 +
    (sb - 8) * 3.2 +
    (avg - 0.258) * ab * 3.5;
  return Math.round(Math.max(1, score * 0.28 + 15));
}

export function calcPitcherValue(stat: Record<string, string | number>): number {
  const era = parseFloat(String(stat.era ?? "9"));
  const whip = parseFloat(String(stat.whip ?? "2"));
  const k = Number(stat.strikeOuts ?? 0);
  const w = Number(stat.wins ?? 0);
  const sv = Number(stat.saves ?? 0);
  const ip = parseFloat(String(stat.inningsPitched ?? "0"));
  if (ip < 20 && sv < 5) return 0;
  const score =
    (4.2 - era) * ip * 0.5 +
    (1.28 - whip) * ip * 1.2 +
    (k - 150) * 0.18 +
    (w - 9) * 2.5 +
    sv * 2.8;
  return Math.round(Math.max(1, score * 0.22 + 12));
}

/**
 * Catalog **value** / tier should track the same blended **projection** shown on the row when it is
 * stronger than the anchor-season split dollar (short injured seasons can collapse anchor `calcBatterValue`).
 */
export function catalogValueFromBattingProjection(bat: Record<string, unknown>): number {
  const ab = Number(bat.atBats ?? 0);
  if (ab < 100) return 0;
  const hr = Number(bat.hr ?? bat.homeRuns ?? 0);
  const rbi = Number(bat.rbi ?? 0);
  const runs = Number(bat.runs ?? 0);
  const sb = Number(bat.sb ?? bat.stolenBases ?? 0);
  const avgRaw = bat.avg;
  const avg =
    typeof avgRaw === "number" && Number.isFinite(avgRaw)
      ? avgRaw < 1
        ? avgRaw.toFixed(3)
        : String(avgRaw)
      : String(avgRaw ?? ".000");
  return calcBatterValue({
    homeRuns: hr,
    rbi,
    runs,
    stolenBases: sb,
    avg,
    atBats: ab,
  });
}

export function catalogValueFromPitchingProjection(pit: Record<string, unknown>): number {
  const ipRaw = pit.inningsPitched ?? pit.innings ?? "0";
  const ipStr = typeof ipRaw === "number" ? String(ipRaw) : String(ipRaw);
  return calcPitcherValue({
    era: String(pit.era ?? "9"),
    whip: String(pit.whip ?? "2"),
    strikeOuts: Number(pit.strikeOuts ?? pit.strikeouts ?? 0),
    wins: Number(pit.wins ?? 0),
    saves: Number(pit.saves ?? 0),
    inningsPitched: ipStr,
  });
}

/** Max dollar from blended projection batting/pitching objects (same formula family as anchor splits). */
export function catalogDollarValueFromProjection(projection: Record<string, unknown>): number {
  let max = 0;
  const bat = projection.batting as Record<string, unknown> | undefined;
  const pit = projection.pitching as Record<string, unknown> | undefined;
  if (bat && typeof bat === "object") max = Math.max(max, catalogValueFromBattingProjection(bat));
  if (pit && typeof pit === "object") max = Math.max(max, catalogValueFromPitchingProjection(pit));
  return max;
}
