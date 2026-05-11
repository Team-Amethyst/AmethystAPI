/**
 * Resolve NFBC-backed MLB candidate IDs from a dry-run preview JSON (optional)
 * or from explicit numeric id lists.
 */
export function extractNfbcMlbIdsFromMarketPreview(preview: unknown): Set<number> {
  const s = new Set<number>();
  if (!preview || typeof preview !== "object") return s;
  const matches = (preview as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return s;
  for (const m of matches) {
    if (!m || typeof m !== "object") continue;
    const row = m as {
      kind?: string;
      vendor?: { mlb_id?: number | null };
      catalog_player?: { mlbId?: number };
    };
    const vid = row.vendor?.mlb_id;
    if (typeof vid === "number" && Number.isFinite(vid) && vid > 0) {
      s.add(Math.trunc(vid));
    }
    const cid = row.catalog_player?.mlbId;
    if (typeof cid === "number" && Number.isFinite(cid) && cid > 0) {
      s.add(Math.trunc(cid));
    }
  }
  return s;
}
