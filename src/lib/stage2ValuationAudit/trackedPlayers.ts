/** Tracked players for Stage 2 confidence audit (audit-only ADP comparison). */
export const TRACKED_HITTERS = [
  "Aaron Judge",
  "Julio Rodríguez",
  "Julio Rodriguez",
  "Bobby Witt Jr.",
  "José Ramírez",
  "Jose Ramirez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Anthony Volpe",
  "Jazz Chisholm Jr.",
  "Luis Arraez",
  "Jarren Duran",
  "Riley Greene",
  "Pete Alonso",
  "Kyle Stowers",
  "Cody Bellinger",
  "Spencer Jones",
] as const;

export const TRACKED_PITCHERS = [
  "Tarik Skubal",
  "Bryan Woo",
  "Garrett Crochet",
  "Drew Rasmussen",
  "Mason Miller",
  "Joe Ryan",
  "Logan Gilbert",
  "Chris Sale",
  "David Bednar",
  "Camilo Doval",
  "Fernando Cruz",
  "Will Warren",
] as const;

export const TRACKED_PLAYERS = [...TRACKED_HITTERS, ...TRACKED_PITCHERS];

/** Canonical display name per normalized key (first alias wins). */
export function trackedCanonicalNames(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of TRACKED_PLAYERS) {
    const k = n
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}
