/** Pick players from checkpoint fixture JSON for the Playground (labels + availability buckets). */

export type FixturePlayerBucketKind = "available" | "drafted" | "roster";

export type FixturePlayerOption = {
  id: string;
  /** Display only — name and position (no player_id suffix). */
  label: string;
  /** Present when row came from `drafted_players` (auction picks). */
  pickNumber?: number;
  /** Which bucket this row came from (for Playground UI). */
  bucket?: FixturePlayerBucketKind;
};

/** Fixture placeholders (draft-room fictitious IDs) are not in Mongo — valuation returns 404. */
export function isSyntheticPlaceholderPlayerId(id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  const n = Number(id);
  return n >= 9_000_000 && n < 9_100_000;
}

export type FixturePlayerBuckets = {
  /** Pool picks only: not on a pre-draft roster and not yet drafted at this checkpoint (recommended). */
  available: FixturePlayerOption[];
  /** Rows from `drafted_players` (auction picks), sorted by pick_number. */
  draftedThisSession: FixturePlayerOption[];
  /** Keepers / minors / taxi slots from `pre_draft_rosters` (may overlap drafted only if fixture is inconsistent). */
  onRosters: FixturePlayerOption[];
};

function normalizePlayerId(v: unknown): string | undefined {
  if (typeof v === "string" && /^\d+$/.test(v) && v.length <= 16) return v;
  if (typeof v === "number" && Number.isFinite(v)) {
    const s = String(Math.trunc(v));
    if (/^\d+$/.test(s) && s.length <= 16) return s;
  }
  return undefined;
}

function walkCollectLabels(v: unknown, depth: number, labels: Map<string, { name: string; position: string }>) {
  if (depth > 24) return;
  if (v === null || v === undefined) return;
  if (typeof v !== "object") return;

  if (Array.isArray(v)) {
    for (const x of v) walkCollectLabels(x, depth + 1, labels);
    return;
  }

  const o = v as Record<string, unknown>;
  const id = normalizePlayerId(o.player_id);
  if (id && !labels.has(id)) {
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const pos = typeof o.position === "string" ? o.position.trim() : "";
    labels.set(id, { name, position: pos });
  }
  for (const val of Object.values(o)) walkCollectLabels(val, depth + 1, labels);
}

function addPlayerIdsFromTeamBlockList(block: unknown, ids: Set<string>): void {
  if (!Array.isArray(block)) return;
  for (const team of block) {
    if (typeof team !== "object" || team === null) continue;
    const players = (team as Record<string, unknown>).players;
    if (!Array.isArray(players)) continue;
    for (const row of players) {
      if (typeof row !== "object" || row === null) continue;
      const id = normalizePlayerId((row as Record<string, unknown>).player_id);
      if (id) ids.add(id);
    }
  }
}

/** Union of roster slots: active roster, minors, and taxi (same team→players shape as `pre_draft_rosters`). */
function rosteredIdsFromFixture(parsed: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  addPlayerIdsFromTeamBlockList(parsed.pre_draft_rosters, ids);
  addPlayerIdsFromTeamBlockList(parsed.minors, ids);
  addPlayerIdsFromTeamBlockList(parsed.taxi, ids);
  return ids;
}

function draftedRowsFromFixture(parsed: Record<string, unknown>): {
  id: string;
  pickNumber?: number;
  name?: string;
  position?: string;
}[] {
  const dp = parsed.drafted_players;
  if (!Array.isArray(dp)) return [];
  const out: { id: string; pickNumber?: number; name?: string; position?: string }[] = [];
  for (const row of dp) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    const id = normalizePlayerId(rec.player_id);
    if (!id) continue;
    const pn = rec.pick_number;
    const pickNumber =
      typeof pn === "number" && Number.isFinite(pn)
        ? Math.trunc(pn)
        : typeof pn === "string" && /^\d+$/.test(pn)
          ? Number.parseInt(pn, 10)
          : undefined;
    const name = typeof rec.name === "string" ? rec.name.trim() : undefined;
    const position = typeof rec.position === "string" ? rec.position.trim() : undefined;
    out.push({ id, pickNumber, name, position });
  }
  out.sort((a, b) => (a.pickNumber ?? 99999) - (b.pickNumber ?? 99999));
  return out;
}

function formatDisplayLabel(
  id: string,
  meta: { name: string; position: string } | undefined,
  suffix?: string,
): string {
  const name = meta?.name ?? "";
  const pos = meta?.position ?? "";
  const parts = [name || null, pos ? pos : null].filter(Boolean);
  let base = parts.length ? parts.join(" · ") : `Unknown (${id})`;
  if (suffix) base = `${base} ${suffix}`;
  return base;
}

const emptyBuckets = (): FixturePlayerBuckets => ({
  available: [],
  draftedThisSession: [],
  onRosters: [],
});

/**
 * Groups fixture players the same way the valuation pipeline treats draft state:
 * `drafted_players` are auction picks; `pre_draft_rosters`, `minors`, and `taxi` are roster slots (unavailable from the pool).
 */
export function fixturePlayerBucketsFromRaw(raw: string): FixturePlayerBuckets {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return emptyBuckets();
  }

  const labels = new Map<string, { name: string; position: string }>();
  walkCollectLabels(parsed, 0, labels);

  const eligRoot = parsed.eligible_player_ids;
  if (Array.isArray(eligRoot)) {
    for (const x of eligRoot) {
      const id = normalizePlayerId(x);
      if (id && !labels.has(id)) labels.set(id, { name: "", position: "" });
    }
  }

  const rostered = rosteredIdsFromFixture(parsed);
  const draftedRows = draftedRowsFromFixture(parsed);
  const draftedIds = new Set(draftedRows.map((r) => r.id));

  let eligible: Set<string> | null = null;
  if (Array.isArray(eligRoot) && eligRoot.length > 0 && eligRoot.every((x) => typeof x === "string")) {
    eligible = new Set(eligRoot as string[]);
  }

  const unavailable = new Set<string>([...rostered, ...draftedIds]);

  const draftedThisSession: FixturePlayerOption[] = [];
  for (const r of draftedRows) {
    if (isSyntheticPlaceholderPlayerId(r.id)) continue;
    const meta = labels.get(r.id);
    const labelSource = {
      name: r.name ?? meta?.name ?? "",
      position: r.position ?? meta?.position ?? "",
    };
    const base = formatDisplayLabel(r.id, labelSource);
    const label = r.pickNumber != null ? `#${r.pickNumber} · ${base}` : base;
    draftedThisSession.push({
      id: r.id,
      label,
      pickNumber: r.pickNumber,
      bucket: "drafted",
    });
  }

  const onRosters: FixturePlayerOption[] = [];
  const rosterSeen = new Set<string>();

  const pushOnRosterBlock = (block: unknown, suffix: string) => {
    if (!Array.isArray(block)) return;
    for (const team of block) {
      if (typeof team !== "object" || team === null) continue;
      const players = (team as Record<string, unknown>).players;
      if (!Array.isArray(players)) continue;
      for (const row of players) {
        if (typeof row !== "object" || row === null) continue;
        const rec = row as Record<string, unknown>;
        const id = normalizePlayerId(rec.player_id);
        if (!id || draftedIds.has(id) || isSyntheticPlaceholderPlayerId(id)) continue;
        if (rosterSeen.has(id)) continue;
        rosterSeen.add(id);
        const meta = labels.get(id);
        const name =
          typeof rec.name === "string" ? rec.name.trim() : meta?.name ?? "";
        const position =
          typeof rec.position === "string" ? rec.position.trim() : meta?.position ?? "";
        onRosters.push({
          id,
          label: formatDisplayLabel(id, { name, position }, suffix),
          bucket: "roster",
        });
      }
    }
  };

  pushOnRosterBlock(parsed.pre_draft_rosters, "· roster");
  pushOnRosterBlock(parsed.minors, "· minors");
  pushOnRosterBlock(parsed.taxi, "· taxi");

  const available: FixturePlayerOption[] = [];
  for (const id of labels.keys()) {
    if (unavailable.has(id)) continue;
    if (eligible && !eligible.has(id)) continue;
    if (isSyntheticPlaceholderPlayerId(id)) continue;
    available.push({
      id,
      label: formatDisplayLabel(id, labels.get(id)),
      bucket: "available",
    });
  }

  const sortByLabel = (a: FixturePlayerOption, b: FixturePlayerOption) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

  available.sort(sortByLabel);
  onRosters.sort(sortByLabel);

  return { available, draftedThisSession, onRosters };
}

/**
 * @deprecated Use {@link fixturePlayerBucketsFromRaw} for grouped selection.
 * Flat list (visit order) kept for tests / callers that expect a single array.
 */
export function fixturePlayersFromRaw(raw: string, limit = 200): FixturePlayerOption[] {
  const b = fixturePlayerBucketsFromRaw(raw);
  const merged = [...b.available, ...b.draftedThisSession, ...b.onRosters];
  const seen = new Set<string>();
  const out: FixturePlayerOption[] = [];
  for (const p of merged) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
