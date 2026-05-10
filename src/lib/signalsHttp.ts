import { createHash } from "crypto";
import type { NewsSignal } from "../types/brain";

/**
 * Strong ETag for /signals/news: hash of the stable JSON payload (`signals` + `count`
 * only — excludes `fetched_at` so unchanged MLB snapshots keep the same validator).
 */
export function stableSignalsPayloadFingerprint(
  signals: NewsSignal[],
  count: number
): string {
  const body = JSON.stringify({ count, signals });
  return createHash("sha256").update(body).digest("hex");
}

/** RFC 7232 double-quoted opaque ETag. */
export function formatEtagHeader(fingerprintHex: string): string {
  return `"${fingerprintHex}"`;
}

/**
 * Returns true when the client validator matches the current strong fingerprint
 * (quoted ETag value or bare hex; ignores weak prefix).
 */
export function ifNoneMatchIsCurrent(
  ifNoneMatch: string | undefined,
  fingerprintHex: string
): boolean {
  if (ifNoneMatch == null || ifNoneMatch === "") return false;
  for (const raw of ifNoneMatch.split(",")) {
    let p = raw.trim();
    if (p.startsWith("W/")) p = p.slice(2).trim();
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1);
    }
    if (p === fingerprintHex) return true;
  }
  return false;
}
