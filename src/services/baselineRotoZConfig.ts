/**
 * Roto category z-score → baseline projection multiplier in
 * `rotoBaselineForGroup` (`baselineValueEngine.ts`):
 *
 *   projectionMult = clamp(zLo, zHi, 1 + zWeighted * zScale)
 *
 * Tuned with Draftroom-default roster Mongo calibration (replacement_slots_v2):
 * increase star/scrub separation while keeping draftable $ sum ≈ league budget.
 *
 * Previous inline defaults (hitter / pitcher):
 *   zScale 0.08 / 0.092, zLo 0.55 / 0.48, zHi 1.7 / 1.92
 *
 * Experiment sweep (Mongo `standard_12_mixed`, Draftroom roster; Jan 2026):
 * | id   | h.zScale | h.zHi | p.zScale | p.zHi | top$ | topP$ | ge40 | ge30 | hit% | ratio252 |
 * |------|----------|-------|----------|-------|------|-------|------|------|------|----------|
 * | C    | 0.13     | 2.12  | 0.105    | 2.06  | 41.40| 23.12 | 1    | 18   | 72.6 | ~1.000   |
 * | D1   | 0.122    | 2.12  | 0.112    | 2.10  | 35.02| 25.33 | 0    | 10   | 67.7 | ~1.000   |
 * | E17✓ | 0.128    | 2.12  | 0.11     | 2.09  | 39.15| 24.16 | 0    | 14   | 68.9 | ~1.000   |
 * | E24  | 0.128    | 2.12  | 0.12     | 2.06  | 40.59| 22.16 | 1    | 18   | 73.0 | ~1.000   |
 *
 * **Shipped (post-audit D):** slightly **lower** hitter `zScale`, **higher** pitcher `zScale`
 * and pitcher `zHi` — rebalances dollar share toward pitchers without touching
 * `replacement_slots_v2`. Mongo: top **~$39** SS, top pitcher **~$24**,
 * hitter share **~69%** (vs **~73%** on C), draftable $/budget **≈ 1.0**.
 *
 * **May 2026 pitcher rebalance (canonical catalog):** `zHi` raised **+0.10** together with
 * pitcher intrinsic base **+3** in `baselineValueEngine.ts` — targets realistic mixed-league
 * hitter/pitcher auction splits while keeping Σauction≈league budget. Roster shapes that
 * collapse hitting demand (generic **P**) or shrink the pool (`eligible_player_ids`) remain
 * warning-heavy edge cases, not the Draftroom default calibration target.
 *
 * **Rate-only ERA/WHIP (May 2026):** Pitcher `zScale` / `zHi` tuned with intrinsic **22** and
 * `categoryWeight`(ERA/WHIP) **11** so Σauction hitter share sits ~65–72% while aces stay above
 * replacement (no ERA×IP penalty).
 */
export const ROTO_Z_HITTER = {
  zScale: 0.128,
  zLo: 0.52,
  zHi: 2.12,
} as const;

export const ROTO_Z_PITCHER = {
  zScale: 0.102,
  zLo: 0.46,
  zHi: 2.06,
} as const;
