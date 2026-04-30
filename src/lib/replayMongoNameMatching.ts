import type { LeanPlayer } from "../types/brain";

export function foldDisplayName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
}

/** Remove Jr/Sr/II suffixes on a folded lowercase string. */
export function stripGenerationalSuffixFolded(s: string): string {
  return s
    .replace(/\s+jr\.?$/i, "")
    .replace(/\s+sr\.?$/i, "")
    .replace(/\s+ii+$/i, "")
    .replace(/\s+iii$/i, "")
    .replace(/\s+iv$/i, "")
    .trim();
}

/** Collapse "j.t." style initials for matching (J.T. vs JT). */
export function collapseInitialDotsFolded(s: string): string {
  return s.replace(/(?<=[a-z])\.(?=[a-z])/g, "");
}

/** Keys used to join fixture display names to Mongo rows (exact pass). */
export function expandNameKeys(displayName: string): string[] {
  const raw = foldDisplayName(displayName);
  const noDots = collapseInitialDotsFolded(raw);
  const keys = new Set<string>();
  for (const base of [raw, noDots]) {
    keys.add(base);
    keys.add(stripGenerationalSuffixFolded(base));
  }
  return [...keys].filter((k) => k.length > 0);
}

export function namesLooselyMatchFolded(a: string, b: string): boolean {
  return foldDisplayName(a) === foldDisplayName(b);
}

const FOLDED_DISPLAY_ALIAS = new Map<string, string>([
  ["xander boegarts", "xander bogaerts"],
  ["willy castro", "willi castro"],
  ["conor norby", "connor norby"],
]);

export function allFixtureLookupKeys(displayName: string): string[] {
  const keys = [...expandNameKeys(displayName)];
  const primary = foldDisplayName(displayName);
  const alias = FOLDED_DISPLAY_ALIAS.get(primary);
  if (alias) {
    keys.push(alias);
    for (const k of expandNameKeys(alias)) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  return [...new Set(keys)];
}

export function addToNameIndex(
  nameIndex: Map<string, LeanPlayer[]>,
  player: LeanPlayer,
  displayName: string
): void {
  for (const key of expandNameKeys(displayName)) {
    if (!nameIndex.has(key)) nameIndex.set(key, []);
    nameIndex.get(key)!.push(player);
  }
}
