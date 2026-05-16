# Legacy flat checkpoint files (AmethystAPI)

These **`after_pick_*.json`** files are **flat** valuation bodies used by older API tests and `public/fixtures/checkpoints/`. They use a **22-slot-per-team** template (198 league capacity with 9 teams).

**Do not use them for production curve audit.** Canonical nested checkpoints live in AmethystDraft:

`AmethystDraft/apps/api/test-fixtures/player-api/checkpoints/`

(`after_10.json`, … — see `CHECKPOINTS.md` there.)

`pnpm valuation-curve-audit` loads Draft fixtures only. See `docs/valuation-inflation-semantics.md` § Checkpoint fixtures.
