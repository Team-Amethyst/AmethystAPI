/**
 * Apply ONLY explicitly allowlisted Mongo deletes on `players` — never runs without
 * --apply, matching env confirmation, and a JSON allowlist file.
 *
 * Usage:
 *   pnpm exec ts-node --project tsconfig.scripts.json scripts/apply-catalog-cleanup-allowlist.ts --allowlist path/to/allowlist.json
 *   CATALOG_CLEANUP_APPLY_CONFIRM=YES pnpm exec ts-node ... --apply --allowlist path/to/allowlist.json
 *
 * Supported operations: deleteOne on collection players with filter { _id: ObjectId } only.
 * Projection patches belong in manual mongosh / ops tools — not this script.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import mongoose, { Types } from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";
import path from "path";
import Player from "../src/models/Player";

const ROOT = path.resolve(__dirname, "..");

const HEX24 = /^[a-f0-9]{24}$/i;

type AllowlistV1 = {
  version: 1;
  approvedBy: string;
  approvedAt: string;
  operations: Array<{
    op: "deleteOne";
    mongo_id: string;
    reason?: string;
    match_key?: string;
  }>;
};

function parseArgs(argv: string[]): { allowlist: string | null; apply: boolean } {
  let allowlist: string | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    if (a.startsWith("--allowlist=")) allowlist = a.slice("--allowlist=".length);
    if (a === "--allowlist" && argv[i + 1]) {
      allowlist = argv[i + 1]!;
      i++;
    }
  }
  return { allowlist: allowlist ? path.resolve(ROOT, allowlist) : null, apply };
}

function validateAllowlist(raw: unknown): AllowlistV1 {
  if (raw == null || typeof raw !== "object") throw new Error("Allowlist must be a JSON object");
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new Error('Allowlist version must be 1');
  if (typeof o.approvedBy !== "string" || !o.approvedBy.trim())
    throw new Error("approvedBy is required");
  if (typeof o.approvedAt !== "string") throw new Error("approvedAt is required");
  const ops = o.operations;
  if (!Array.isArray(ops) || ops.length === 0) throw new Error("operations[] must be non-empty");
  for (const x of ops) {
    if (typeof x !== "object" || x == null) throw new Error("Invalid operation entry");
    const e = x as Record<string, unknown>;
    if (e.op !== "deleteOne") throw new Error(`Unsupported op: ${String(e.op)}`);
    if (typeof e.mongo_id !== "string" || !HEX24.test(e.mongo_id))
      throw new Error(`Invalid mongo_id: ${String(e.mongo_id)}`);
  }
  return o as unknown as AllowlistV1;
}

async function main(): Promise<void> {
  const { allowlist: allowlistPath, apply } = parseArgs(process.argv.slice(2));
  if (!allowlistPath) {
    console.error("Usage: --allowlist <path-to-json> [--apply]");
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const list = validateAllowlist(raw);

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          would_delete_count: list.operations.length,
          approvedBy: list.approvedBy,
          approvedAt: list.approvedAt,
          mongo_ids: list.operations.map((o) => o.mongo_id),
          hint: "Re-run with --apply after setting CATALOG_CLEANUP_APPLY_CONFIRM=YES",
        },
        null,
        2
      )
    );
    return;
  }

  if (process.env.CATALOG_CLEANUP_APPLY_CONFIRM !== "YES") {
    console.error(
      "Refusing to apply: set environment variable CATALOG_CLEANUP_APPLY_CONFIRM=YES for destructive deletes."
    );
    process.exit(3);
  }

  const uri = process.env.MONGO_URI?.trim();
  if (!uri) {
    console.error("MONGO_URI required");
    process.exit(1);
  }

  await mongoose.connect(uri, scriptMongoConnectOptions());
  try {
    const results: Record<string, unknown>[] = [];
    for (const op of list.operations) {
      const oid = new Types.ObjectId(op.mongo_id);
      const res = await Player.collection.deleteOne({ _id: oid });
      results.push({
        mongo_id: op.mongo_id,
        deletedCount: res.deletedCount,
        match_key: op.match_key ?? null,
      });
    }
    console.log(
      JSON.stringify(
        {
          applied: true,
          approvedBy: list.approvedBy,
          approvedAt: list.approvedAt,
          source_allowlist: allowlistPath,
          results,
        },
        null,
        2
      )
    );
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
