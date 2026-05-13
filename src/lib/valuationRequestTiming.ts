/**
 * Optional POST /valuation/* phase diagnostics (timings + counts).
 * Enable with VALUATION_REQUEST_TIMING=1 — logs structured `valuation_request_timing` and
 * `valuation_http_timing` lines (pino) for triage.
 */

import type { NormalizedValuationInput } from "../types/brain";

export type ValuationRequestDiagnostics = {
  timings_ms: Record<string, number>;
  counts: Record<string, number>;
};

export function createValuationRequestDiagnostics(): ValuationRequestDiagnostics {
  return { timings_ms: {}, counts: {} };
}

export function nowMs(): number {
  return performance.now();
}

export function addTimingMs(
  diag: ValuationRequestDiagnostics,
  key: string,
  start: number,
  end: number = nowMs()
): void {
  diag.timings_ms[key] = (diag.timings_ms[key] ?? 0) + (end - start);
}

export function setCount(diag: ValuationRequestDiagnostics, key: string, n: number): void {
  diag.counts[key] = n;
}

export function incCount(diag: ValuationRequestDiagnostics, key: string, delta: number): void {
  diag.counts[key] = (diag.counts[key] ?? 0) + delta;
}

/** Best-effort request body size without double JSON.stringify when Content-Length is present. */
export function estimateRequestBodyBytes(req: {
  headers: Record<string, unknown>;
  body?: unknown;
}): number {
  const raw = req.headers["content-length"];
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  try {
    return Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
  } catch {
    return -1;
  }
}

export function positionOverridesCount(input: NormalizedValuationInput): number {
  const o = input.position_overrides;
  if (o == null) return 0;
  if (Array.isArray(o)) return o.length;
  if (typeof o === "object") return Object.keys(o as Record<string, unknown>).length;
  return 0;
}

export function injuryOverridesCount(input: NormalizedValuationInput): number {
  const inj = input.injury_overrides;
  if (inj == null) return 0;
  if (Array.isArray(inj)) return inj.length;
  if (typeof inj === "object") return Object.keys(inj as Record<string, unknown>).length;
  return 0;
}

let activeValuationRequests = 0;

export function valuationConcurrencyEnter(): number {
  activeValuationRequests += 1;
  return activeValuationRequests;
}

export function valuationConcurrencyExit(): number {
  activeValuationRequests = Math.max(0, activeValuationRequests - 1);
  return activeValuationRequests;
}

export function valuationConcurrencySnapshot(): number {
  return activeValuationRequests;
}
