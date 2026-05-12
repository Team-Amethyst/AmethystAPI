import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mongoConnect = vi.hoisted(() => vi.fn(async () => undefined));
const mongoDisconnect = vi.hoisted(() => vi.fn(async () => undefined));

const playerUpdateOne = vi.hoisted(() =>
  vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 }))
);
const playerUpdateMany = vi.hoisted(() =>
  vi.fn(async () => ({ modifiedCount: 0 }))
);
const playerCountDocuments = vi.hoisted(() => vi.fn(async () => 0));
const playerFind = vi.hoisted(() =>
  vi.fn(() => ({
    select: () => ({
      limit: () => ({
        lean: async () => [],
      }),
    }),
  }))
);

vi.mock("mongoose", () => ({
  default: {
    connect: mongoConnect,
    disconnect: mongoDisconnect,
  },
}));

vi.mock("../src/models/Player", () => ({
  default: {
    updateOne: playerUpdateOne,
    updateMany: playerUpdateMany,
    countDocuments: playerCountDocuments,
    find: playerFind,
  },
}));

import { runMarketAdpApplyCli } from "../src/lib/marketAdp/runMarketAdpApplyCli";

const fixture = path.join(__dirname, "../test-fixtures/market-adp/apply-preview-minimal.json");

describe("runMarketAdpApplyCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.MARKET_ADP_APPLY_CONFIRM;
    delete process.env.MONGO_URI;
  });

  it("dry-run default does not call Player.updateOne or mongoose.connect", async () => {
    await runMarketAdpApplyCli(["node", "script", "--preview", fixture]);
    expect(playerUpdateOne).not.toHaveBeenCalled();
    expect(playerUpdateMany).not.toHaveBeenCalled();
    expect(mongoConnect).not.toHaveBeenCalled();
  });

  it("dry-run with --clear-missing-market-adp uses Mongo for counts only (no updateMany)", async () => {
    process.env.MONGO_URI = "mongodb://localhost";
    await runMarketAdpApplyCli([
      "node",
      "script",
      "--preview",
      fixture,
      "--clear-missing-market-adp",
    ]);
    expect(mongoConnect).toHaveBeenCalled();
    expect(playerCountDocuments).toHaveBeenCalled();
    expect(playerUpdateMany).not.toHaveBeenCalled();
    expect(playerUpdateOne).not.toHaveBeenCalled();
  });

  it("apply without MARKET_ADP_APPLY_CONFIRM throws and performs no writes", async () => {
    process.env.MONGO_URI = "mongodb://localhost";
    await expect(
      runMarketAdpApplyCli(["node", "script", "--preview", fixture, "--apply"])
    ).rejects.toThrow(/MARKET_ADP_APPLY_CONFIRM/);
    expect(mongoConnect).not.toHaveBeenCalled();
    expect(playerUpdateOne).not.toHaveBeenCalled();
  });

  it("apply with confirmation calls updateOne by mlbId only (clear off => no updateMany)", async () => {
    process.env.MONGO_URI = "mongodb://localhost";
    process.env.MARKET_ADP_APPLY_CONFIRM = "YES";
    await runMarketAdpApplyCli(["node", "script", "--preview", fixture, "--apply"]);
    expect(mongoConnect).toHaveBeenCalled();
    expect(playerUpdateOne).toHaveBeenCalledTimes(1);
    expect(playerUpdateOne).toHaveBeenCalledWith(
      { mlbId: 660271 },
      {
        $set: expect.objectContaining({
          market_adp: 12.34,
          market_adp_source: "NFBC",
          market_adp_updated_at: "2026-05-11T00:00:00.000Z",
          market_adp_min: 10,
          market_adp_max: 15,
          market_pick_count: 99,
        }),
      }
    );
    expect(playerUpdateMany).not.toHaveBeenCalled();
  });

  it("apply with --clear-missing-market-adp also runs updateMany for stale rows", async () => {
    process.env.MONGO_URI = "mongodb://localhost";
    process.env.MARKET_ADP_APPLY_CONFIRM = "YES";
    await runMarketAdpApplyCli([
      "node",
      "script",
      "--preview",
      fixture,
      "--apply",
      "--clear-missing-market-adp",
    ]);
    expect(playerUpdateOne).toHaveBeenCalled();
    expect(playerUpdateMany).toHaveBeenCalledTimes(1);
  });
});
