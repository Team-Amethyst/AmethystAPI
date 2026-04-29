import type { LeanPlayer } from "../types/brain";

export type FixturePlayerMeta = {
  name: string;
  position: string;
  team: string;
  /**
   * Optional list $ for stub rows when Mongo has no match (e.g. from auction pick order
   * in replay tooling) so valuations do not collapse to the $1 floor.
   */
  list_value_hint?: number;
};

function normPos(p: string): string {
  const u = p.toUpperCase().trim();
  if (u.includes("RP") && !u.includes("SP")) return "RP";
  if (u.includes("SP")) return "SP";
  if (u.startsWith("P") && u.length <= 2) return "SP";
  return u.split(/[,/]/)[0]?.trim() || "OF";
}

function foldDisplayName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
}

/** Remove Jr/Sr/II suffixes on a folded lowercase string. */
function stripGenerationalSuffixFolded(s: string): string {
  return s
    .replace(/\s+jr\.?$/i, "")
    .replace(/\s+sr\.?$/i, "")
    .replace(/\s+ii+$/i, "")
    .replace(/\s+iii$/i, "")
    .replace(/\s+iv$/i, "")
    .trim();
}

/** Collapse "j.t." style initials for matching (J.T. vs JT). */
function collapseInitialDotsFolded(s: string): string {
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

function namesLooselyMatchFolded(a: string, b: string): boolean {
  return foldDisplayName(a) === foldDisplayName(b);
}

/**
 * Known fixture / sheet typos → canonical folded key present in Mongo nameIndex.
 * Keep tiny and auditable; do not use fuzzy matching on full names (risk of wrong player).
 */
const FOLDED_DISPLAY_ALIAS = new Map<string, string>([
  ["xander boegarts", "xander bogaerts"],
  ["willy castro", "willi castro"],
  ["conor norby", "connor norby"],
]);

function allFixtureLookupKeys(displayName: string): string[] {
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

function addToNameIndex(
  nameIndex: Map<string, LeanPlayer[]>,
  player: LeanPlayer,
  displayName: string
): void {
  for (const key of expandNameKeys(displayName)) {
    if (!nameIndex.has(key)) nameIndex.set(key, []);
    nameIndex.get(key)!.push(player);
  }
}

function resolveStubListValue(meta: FixturePlayerMeta): number {
  if (
    meta.list_value_hint != null &&
    Number.isFinite(meta.list_value_hint) &&
    meta.list_value_hint > 0
  ) {
    return Math.round(Math.min(120, Math.max(4, meta.list_value_hint)) * 100) / 100;
  }
  return 4;
}

/**
 * Merge Mongo catalog with fixture `player_id`s so replay requests resolve every
 * drafted/keeper id (re-key matched Mongo rows to fixture numeric ids when names align).
 */
export function mergeMongoWithFixtureIdentities(
  mongo: LeanPlayer[],
  fixtureById: Map<string, FixturePlayerMeta>
): { pool: LeanPlayer[]; warnings: string[] } {
  const warnings: string[] = [];
  const consumedSourceMlbIds = new Set<number>();
  const rekeyed = new Map<number, LeanPlayer>();

  const byMlbId = new Map<number, LeanPlayer>();
  for (const p of mongo) {
    if (p.mlbId != null && Number.isFinite(p.mlbId)) byMlbId.set(p.mlbId, p);
  }

  const nameIndex = new Map<string, LeanPlayer[]>();
  for (const p of mongo) {
    addToNameIndex(nameIndex, p, p.name);
  }

  for (const [fid, meta] of fixtureById) {
    const idNum = Number(fid);
    if (!Number.isFinite(idNum)) continue;

    const direct = byMlbId.get(idNum);
    let src: LeanPlayer | undefined;
    if (direct) {
      src = direct;
      if (meta.name.trim() && !namesLooselyMatchFolded(direct.name, meta.name)) {
        warnings.push(
          `fixture id ${fid}: name "${meta.name}" vs Mongo "${direct.name}"; using Mongo row by mlbId`
        );
      }
    }

    if (!src) {
      for (const key of allFixtureLookupKeys(meta.name)) {
        const list = nameIndex.get(key);
        if (list && list.length === 1) {
          src = list[0];
          break;
        }
        if (list && list.length > 1) {
          const teamU = (meta.team ?? "").toUpperCase();
          const hit =
            list.find((p) => (p.team ?? "").toUpperCase() === teamU) ??
            list[0] ??
            undefined;
          if (hit) {
            src = hit;
            if (!list.find((p) => (p.team ?? "").toUpperCase() === teamU)) {
              warnings.push(
                `ambiguous name "${meta.name}" for fixture id ${fid}; picked first of ${list.length}`
              );
            }
            break;
          }
        }
      }
    }

    if (src) {
      if (src.mlbId != null && src.mlbId !== idNum) {
        consumedSourceMlbIds.add(src.mlbId);
      }
      rekeyed.set(idNum, {
        ...src,
        mlbId: idNum,
        name: meta.name || src.name,
        team: meta.team || src.team,
        position: normPos(meta.position || src.position),
      });
    } else {
      const stubVal = resolveStubListValue(meta);
      warnings.push(
        `no Mongo row for fixture id ${fid} (${meta.name}); stub list_value=${stubVal}` +
          (meta.list_value_hint != null ? ` (hint from pick order)` : "")
      );
      rekeyed.set(idNum, {
        _id: `fixture_stub_${idNum}`,
        mlbId: idNum,
        name: meta.name || "Unknown",
        team: meta.team || "",
        position: normPos(meta.position),
        adp: 9999,
        tier: 4,
        value: stubVal,
      });
    }
  }

  const out: LeanPlayer[] = [];
  for (const p of mongo) {
    const mid = p.mlbId;
    if (mid != null && consumedSourceMlbIds.has(mid)) continue;
    if (mid != null && rekeyed.has(mid)) {
      warnings.push(
        `Mongo mlbId ${mid} (${p.name}) omitted: fixture player_id ${mid} maps a different player`
      );
      continue;
    }
    out.push(p);
  }
  for (const p of rekeyed.values()) {
    out.push(p);
  }

  return { pool: out, warnings };
}
