# 2026Draft.xlsx → valuation fixtures mapping

Activity #9 / Player API testing uses the instructor workbook **2026Draft.xlsx** (local copy, e.g. `~/Downloads/2026Draft.xlsx`). The repo converts it to five JSON bodies under `test-fixtures/player-api/checkpoints/` (same filenames as before) using [`scripts/convert-2026-draft-xlsx.ts`](../scripts/convert-2026-draft-xlsx.ts).

## Worksheets

| Sheet | Role |
|-------|------|
| **Pre-Draft Roster** | Row 0: `Team X $remaining` per team (teams A–E in sample). Rows 1+: repeating 4-column blocks per team: `slot`, `player name`, `tier/scouting label`, `keeper salary` (number). Empty name = empty slot. |
| **Minors** | Row 0: `Team A`, `Team B`, … columns. Data rows: pairs `(slot #, player name)` per team column group (two columns per team). |
| **Draft** | Columns: `Pick #`, `Brought Up` (nominating team), `Player`, `POS`, `MLB` (franchise), `Won` (winning fantasy team), `Salary`. Cumulative picks build `drafted_players[]`; `team_id` / spend use **Won** and **Salary**. |
| **Final Roster** | Same grid pattern as Pre-Draft (post-auction); used by the script only if we extend fixtures; current checkpoints use Pre-Draft + Draft only. |
| **Taxi** | Same pattern as Minors for taxi squads; optional future extension. For the five auction checkpoints, `taxi` is `[]`. |

## JSON output (per checkpoint)

- **`schema_version`**: `"1.0.0"`
- **`checkpoint`**: `pre_draft` \| `after_pick_10` \| `after_pick_50` \| `after_pick_100` \| `after_pick_130`
- **`roster_slots` / `scoring_categories` / `scoring_format` / `total_budget`**: Not present in the workbook; script uses fixed league defaults (9 teams in sample, `$260` cap, 5×5-style categories, multi-slot roster matching the pre-draft slot labels).
- **`num_teams`**: Inferred from distinct `Won` / `Brought Up` values on the Draft sheet (falls back to `12`).
- **`league_scope`**: `"Mixed"`.
- **`drafted_players`**: For `pre_draft`, `[]`. For `after_pick_*`, first *N* rows from **Draft** (excluding header), same shape as [`valuation-request.v1.schema.json`](../schemas/valuation-request.v1.schema.json) (`player_id`, `name`, `position`, `team`, `team_id`, `paid`, `pick_number`).
- **`pre_draft_rosters`**: Array of `{ team_id, players[] }` built from **Pre-Draft Roster** (keepers on roster before the auction).
- **`minors`**: Array of `{ team_id, players[] }` from **Minors** (slot/salary omitted or `0` where unknown).
- **`budget_by_team_id`**: Starting budget from Pre-Draft row 0 (`Team X $NNN`); teams without a cell default to `total_budget`. At each checkpoint, cumulative **Draft** salaries won by that team are subtracted so remaining dollars match mid-draft state.
- **`deterministic` / `seed`**: `true` / `42` for stable grading.

## `player_id` (no MLB id column in Excel)

The workbook does not include MLB Stats API ids. The converter assigns each distinct **player name** a stable synthetic id `"1"`, `"2"`, … for the duration of the generated files. **Integration tests** use a large enough mocked catalog (see `test/valuationCalculate.integration.test.ts`) so every referenced id exists.

For production / Mongo-backed runs, replace synthetic ids with real `mlbId` strings from your synced `players` collection (e.g. a follow-up resolver script keyed by name + franchise).

## Regenerating fixtures

```bash
pnpm run convert-2026-draft -- "/path/to/2026Draft.xlsx"
```

Default input path: `../Downloads/2026Draft.xlsx` relative to repo (override with CLI arg). Writes:

- `test-fixtures/player-api/checkpoints/*.json`
- `public/fixtures/checkpoints/*.json` (same bodies for the developer portal sandbox)
