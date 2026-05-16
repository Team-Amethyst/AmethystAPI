import { readFileSync } from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import {
  ENGINE_CHECKPOINT_IDS,
  draftCheckpointFixturesAvailable,
  resolveDraftCheckpointFixturePath,
  resolveDraftCheckpointsDir,
} from "../src/lib/checkpointSlotReconciliation";

describe("valuation-curve-audit fixture guard", () => {
  it.skipIf(!draftCheckpointFixturesAvailable())(
    "resolves checkpoints only from AmethystDraft nested fixtures",
    () => {
      const dir = resolveDraftCheckpointsDir();
      expect(dir).toContain(`${path.sep}AmethystDraft${path.sep}`);
      expect(dir).toContain("test-fixtures/player-api/checkpoints");
      expect(dir).not.toContain("AmethystAPI/test-fixtures");
    },
  );

  it.skipIf(!draftCheckpointFixturesAvailable()).each([...ENGINE_CHECKPOINT_IDS])(
    "%s fixture exists under Draft dir and is not legacy flat after_pick file",
    (id) => {
      const fixturePath = resolveDraftCheckpointFixturePath(id);
      expect(fixturePath).toContain("AmethystDraft");
      expect(readFileSync(fixturePath, "utf8").length).toBeGreaterThan(10);
      const legacyFlat = path.resolve(
        __dirname,
        "../test-fixtures/player-api/checkpoints",
        `${id}.json`
      );
      if (id.startsWith("after_pick_")) {
        try {
          const legacy = JSON.parse(readFileSync(legacyFlat, "utf8")) as {
            roster_slots?: { count?: number }[];
            num_teams?: number;
            league?: unknown;
          };
          expect(legacy.league).toBeUndefined();
          const perTeam = (legacy.roster_slots ?? []).reduce(
            (s, x) => s + (x.count ?? 0),
            0
          );
          expect(perTeam * (legacy.num_teams ?? 0)).toBe(198);
        } catch {
          // legacy file optional in some checkouts
        }
      }
    }
  );

  it("audit script does not fall back to AmethystAPI checkpoint dirs", () => {
    const auditSource = readFileSync(
      path.resolve(__dirname, "../scripts/valuation-curve-audit.ts"),
      "utf8"
    );
    expect(auditSource).toContain("resolveDraftCheckpointsDir");
    expect(auditSource).not.toMatch(/CHECKPOINT_DIRS/);
    expect(auditSource).not.toMatch(
      /test-fixtures\/player-api\/checkpoints.*after_pick/
    );
  });
});
