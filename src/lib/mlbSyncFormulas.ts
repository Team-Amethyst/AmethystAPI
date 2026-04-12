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
