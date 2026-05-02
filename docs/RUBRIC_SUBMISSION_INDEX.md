# Rubric submission index (Engine + Draft)

One-page **table of contents** for reviewers. **AmethystAPI** = Engine; **[AmethystDraft](https://github.com/Team-Amethyst/AmethystDraft)** = product UI + BFF.

## Cross-repo integration

| Doc | Purpose |
|-----|---------|
| [amethystdraft-engine-integration.md](amethystdraft-engine-integration.md) | How Draft should call Engine; mediation audit; dashboard/TC; CI hints. |
| [draft-kit-license-runbook.md](draft-kit-license-runbook.md) | Mediation, `.env`, optional IP allowlist vs WAF. |
| [pre-deploy-testing-keys.md](pre-deploy-testing-keys.md) | Smoke tests across Engine + Draft headers. |

## Rubric evidence matrices (this repo)

| Doc | Scope |
|-----|--------|
| [rubric-player-api-licensing.md](rubric-player-api-licensing.md) | Keys, scopes, tiers, throttling, IP gate, portal vs Draft UI. |
| [rubric-player-api-valuations.md](rubric-player-api-valuations.md) | Aggregator→engine path, TC1–TC5, valuation quality tests. |

## API contract artifacts

| Artifact | Path |
|----------|------|
| OpenAPI | [openapi/openapi.yaml](../openapi/openapi.yaml) |
| Flat request JSON Schema | [schemas/valuation-request.v1.schema.json](../schemas/valuation-request.v1.schema.json) |
| Agent / integrator brief | [ENGINE_AGENT_BRIEF.md](../ENGINE_AGENT_BRIEF.md) |

## Fixtures

| Use | Path |
|-----|------|
| Player API checkpoints (CI) | [test-fixtures/player-api/checkpoints/](../test-fixtures/player-api/checkpoints/) |
| Calibration benchmark | [test-fixtures/valuation-calibration/manual-benchmark.json](../test-fixtures/valuation-calibration/manual-benchmark.json) |

## Roadmap (honest gap)

| Doc | When rubric weights it |
|-----|-------------------------|
| [roadmap-scoring-baseline-v2.md](roadmap-scoring-baseline-v2.md) | Per-format stat→dollar baseline beyond current v1 behavior. |

## Run tests (Engine)

```bash
pnpm test
```
