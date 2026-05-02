# Roadmap: per-format scoring baseline (v2)

## Current state (v1 — documented)

[`README.md`](../README.md) (valuation model table) and [`src/services/valuationWorkflow.ts`](../src/services/valuationWorkflow.ts):

- `resolveScoringMode` distinguishes **points** vs **rotisserie-style** categories for logging and future work.
- **Both paths still use the stored catalog `value`** as the baseline before inflation and quality gates.

That satisfies **“single engine path + explainability + tests”** today. It does **not** fully satisfy a rubric that requires **distinct per-format dollar math** (independent stat→dollar curves per `scoring_format` / `scoring_categories`).

## Goal (v2)

Before `calculateInflation`:

1. Derive **baseline auction dollars** (or a normalized score then mapped to dollars) from:
   - `scoring_format`, `scoring_categories`, `roster_slots`, and catalog stat fields (`stats`, `projection`, …).
2. Keep **one** `executeValuationWorkflow` entry so HTTP semantics and `validateValuationResponse` stay unchanged.
3. Expand **Vitest** in `test/baselineValueEngine.test.ts` (and integration tests) so roto vs points fixtures diverge **when the rubric expects them to**.

## Suggested work packages

| Package | Touchpoints |
|---------|-------------|
| A. Stat vector extraction | [`src/services/baselineProjectionStats.ts`](../src/services/baselineProjectionStats.ts), catalog types |
| B. Points mapping | Category weights, roster slot demand → dollar scaling |
| C. Roto mapping | Per-category z-score or SGP-style partial → dollar scaling |
| D. Regression guard | Snapshot or bounded-range assertions on fixture checkpoints |

## When to schedule

- **If graders score per-format accuracy:** prioritize Package A–C ahead of cosmetic UI.
- **If graders only require “scoring_mode logged + correct request body”:** keep v1 and point reviewers to [`docs/rubric-player-api-valuations.md`](rubric-player-api-valuations.md) + README honesty table.
