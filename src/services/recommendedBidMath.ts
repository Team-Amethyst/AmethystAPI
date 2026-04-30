import type { DraftPhaseIndicator } from "../types/brain";

export function baseLambdaClearingPrice(
  phase: DraftPhaseIndicator,
  depthFrac: number
): number {
  const t = Math.max(0, Math.min(1, depthFrac));
  const elite = 1 - t;
  switch (phase) {
    case "early":
      return 0.5 + 0.28 * elite ** 1.25;
    case "mid":
      return 0.42 + 0.24 * elite ** 1.15;
    case "late":
      return 0.18 + 0.22 * elite ** 1.25;
    default:
      return 0.46;
  }
}

export function isotonicNonIncreasing(values: number[]): number[] {
  if (values.length <= 1) return [...values];
  const blocks: Array<{ sum: number; count: number }> = [];
  for (const v of values) {
    blocks.push({ sum: v, count: 1 });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      const meanA = a.sum / a.count;
      const meanB = b.sum / b.count;
      if (meanA >= meanB) break;
      blocks.splice(blocks.length - 2, 2, {
        sum: a.sum + b.sum,
        count: a.count + b.count,
      });
    }
  }
  const out: number[] = [];
  for (const b of blocks) {
    const m = b.sum / b.count;
    for (let i = 0; i < b.count; i++) out.push(m);
  }
  return out;
}

export function isPitcherPosition(pos: string): boolean {
  const toks = pos.toUpperCase().split(/[,/ ]+/).filter(Boolean);
  return toks.some((t) => t === "SP" || t === "RP" || t === "P");
}
