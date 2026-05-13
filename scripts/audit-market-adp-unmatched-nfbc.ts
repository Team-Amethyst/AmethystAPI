import axios from "axios";
import { readFileSync } from "fs";
import path from "path";

import dotenv from "dotenv";
import mongoose from "mongoose";
import { scriptMongoConnectOptions } from "../src/lib/mongoPoolConfig";

import { normalizePlayerName } from "../src/lib/catalogIdentityHelpers";
import type { LeanPlayer } from "../src/types/brain";
import Player from "../src/models/Player";

import { resolveViaMlbSearch } from "./lib/draftPlayerIdResolve";

dotenv.config();

type Preview = {
  matches: Array<any>;
  adapter_display_name?: string;
};

type UnmatchedVendor = {
  vendor: {
    name: string;
    team: string;
    position: string;
    adp: number;
    mlb_id?: number | null;
  };
};

type PeopleInfo = {
  active?: boolean;
  currentTeam?: { id?: number; name?: string };
};

type StatusInfo = {
  code?: string;
  description?: string;
};

type Classified = {
  vendor: UnmatchedVendor["vendor"];
  resolved?: { mlbId: number; method: string; canonicalName?: string };
  people?: PeopleInfo;
  rosterStatus?: StatusInfo;
  inCatalog: boolean;
  projectionPresent: boolean;
  mongoDocExists: boolean;
  // classification bucket
  bucket:
    | "active_mlb_missing_from_catalog"
    | "minors_prospects"
    | "injured_stash"
    | "retired_free_agent_non_roster"
    | "team_mismatch_only"
    | "unknown"
    | "already_present_under_different_name";
};

function rosterStatusFromDescription(desc?: string): { minor: boolean; injured: boolean } {
  const d = (desc || "").toLowerCase();
  const minor = d.includes("minors") || d.includes("reassigned") || d.includes("optioned");
  const injured = d.includes("injured") || d.includes("injury") || d.includes("disabled") || d.includes("il");
  return { minor, injured };
}

async function fetchPeopleInfo(mlbId: number): Promise<PeopleInfo> {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbId}?hydrate=currentTeam`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const person = data.people?.[0] || data;
  return {
    active: person.active,
    currentTeam: person.currentTeam
      ? { id: person.currentTeam.id, name: person.currentTeam.name }
      : undefined,
  };
}

async function fetchTeamRoster40man(teamId: number): Promise<Map<number, StatusInfo>> {
  // fullSeason includes disabled / rehab / reassigned minors entries, which lets us
  // distinguish injured/stash and minors without extra endpoints.
  const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=fullSeason`;
  const { data } = await axios.get(url, { timeout: 20000 });
  // statsapi returns `{ roster: { roster: [...] } }` for this endpoint.
  const rosterArr: any[] =
    (data.roster && Array.isArray((data.roster as any).roster))
      ? (data.roster as any).roster
      : Array.isArray(data.roster)
        ? data.roster
        : [];
  const m = new Map<number, StatusInfo>();
  for (const entry of rosterArr) {
    const pid = entry.person?.id;
    if (typeof pid !== "number" || !Number.isFinite(pid)) continue;
    const status = entry.status;
    m.set(pid, {
      code: status?.code,
      description: status?.description,
    });
  }
  return m;
}

async function main() {
  const previewPath = path.resolve(__dirname, "..", "tmp/nfbc-data-mongo-preview.json");
  const preview = JSON.parse(readFileSync(previewPath, "utf8")) as Preview;

  const unmatchedVendors: UnmatchedVendor[] = (preview.matches || [])
    .filter((m: any) => m && m.kind === "unmatched_vendor")
    .map((m: any) => m as UnmatchedVendor);

  const top300 = [...unmatchedVendors]
    .sort((a, b) => (a.vendor.adp ?? 0) - (b.vendor.adp ?? 0))
    .slice(0, 300);

  if (top300.length === 0) {
    console.error("No unmatched_vendor rows found in preview.");
    process.exit(1);
  }

  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required for this audit (Mongo reads only).");
  }

  // Avoid the default 10s buffering timeout when Mongo is slow to respond.
  mongoose.set("bufferTimeoutMS", 60_000);
  await mongoose.connect(process.env.MONGO_URI!, {
    ...scriptMongoConnectOptions(),
    serverSelectionTimeoutMS: 30_000,
    connectTimeoutMS: 30_000,
  });

  const catalogDocs = await Player.find(
    { catalogKind: "mlb", mlbId: { $gt: 0 } },
    { mlbId: 1, name: 1, projection: 1 }
  ).lean();

  const catalogMlbIdSet = new Set<number>();
  const catalogNormNameSet = new Set<string>();
  for (const p of catalogDocs) {
    const mlbId = (p as any).mlbId;
    if (typeof mlbId === "number" && Number.isFinite(mlbId) && mlbId > 0) {
      catalogMlbIdSet.add(mlbId);
    }
    catalogNormNameSet.add(normalizePlayerName(p.name));
  }

  // Resolve MLB ids
  const resolved: Map<string, { mlbId: number; method: string; canonicalName?: string }> = new Map();
  const resolutionResults: Array<Classified> = [];

  const concurrency = 6;
  let i = 0;
  const workers = new Array(concurrency).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= top300.length) break;
      const row = top300[idx]!;
      const vendor = row.vendor;
      const res = await resolveViaMlbSearch(vendor.name, vendor.team);
      // key by vendor index+name (stable within run)
      resolved.set(String(idx), res ? { mlbId: res.mlbId, method: res.method, canonicalName: res.canonicalName } : undefined as any);

      const inCatalog = res ? catalogMlbIdSet.has(res.mlbId) : false;
      const projectionPresent = false; // fill later
      const normalizedNameInCatalog = catalogNormNameSet.has(normalizePlayerName(vendor.name));

      resolutionResults[idx] = {
        vendor,
        resolved: res ? { mlbId: res.mlbId, method: res.method, canonicalName: res.canonicalName } : undefined,
        inCatalog,
        projectionPresent,
        mongoDocExists: false,
        bucket: res && inCatalog
          ? "already_present_under_different_name"
          : normalizedNameInCatalog
            ? "team_mismatch_only"
            : "unknown",
      };
    }
  });
  await Promise.all(workers);

  // Only consider resolved mlbIds for Mongo projection check / people / roster
  const resolvedIds = new Set<number>();
  for (const r of resolutionResults) {
    if (r && r.resolved) resolvedIds.add(r.resolved.mlbId);
  }

  // Load projection presence from Mongo
  const mongoDocs = new Map<number, any>();
  if (resolvedIds.size > 0) {
    const ids = [...resolvedIds];
    const docs = await Player.find({ mlbId: { $in: ids } }).lean();
    for (const d of docs) {
      if (typeof (d as any).mlbId === "number") mongoDocs.set((d as any).mlbId, d);
    }
  }

  // For each resolved id, fetch people info; group by teamId for roster fetch.
  const peopleById = new Map<number, PeopleInfo>();
  const rosterByTeam = new Map<number, Map<number, StatusInfo>>();

  const idsArr = [...resolvedIds];
  let j = 0;
  const concurrencyPeople = 8;

  const peopleWorkers = new Array(concurrencyPeople).fill(0).map(async () => {
    while (true) {
      const idx = j++;
      if (idx >= idsArr.length) break;
      const mlbId = idsArr[idx]!;
      try {
        const info = await fetchPeopleInfo(mlbId);
        peopleById.set(mlbId, info);
      } catch {
        peopleById.set(mlbId, {});
      }
    }
  });
  await Promise.all(peopleWorkers);

  // Fetch rosters per teamId
  const teamIds = new Set<number>();
  for (const mlbId of resolvedIds) {
    const p = peopleById.get(mlbId);
    const tid = p?.currentTeam?.id;
    if (typeof tid === "number" && Number.isFinite(tid) && tid > 0) teamIds.add(tid);
  }

  const teamArr = [...teamIds];
  let k = 0;
  const concurrencyRoster = 5;
  const rosterWorkers = new Array(concurrencyRoster).fill(0).map(async () => {
    while (true) {
      const idx = k++;
      if (idx >= teamArr.length) break;
      const teamId = teamArr[idx]!;
      try {
        const m = await fetchTeamRoster40man(teamId);
        rosterByTeam.set(teamId, m);
      } catch {
        rosterByTeam.set(teamId, new Map());
      }
    }
  });
  await Promise.all(rosterWorkers);

  // Final classification
  for (const r of resolutionResults) {
    if (!r) continue;
    if (r.resolved) {
      const mlbId = r.resolved.mlbId;
      const mongoDoc = mongoDocs.get(mlbId);
      r.mongoDocExists = mongoDoc != null;
      const projection = mongoDoc?.projection;
      const projectionPresent =
        projection != null &&
        typeof projection === "object" &&
        Object.keys(projection).length > 0;
      r.projectionPresent = projectionPresent;

      const people = peopleById.get(mlbId) || {};
      r.people = people;

      const tid = people.currentTeam?.id;
      if (typeof tid === "number") {
        const rosterMap = rosterByTeam.get(tid);
        const status = rosterMap?.get(mlbId);
        r.rosterStatus = status;
      }

      // Bucket priority
      if (r.bucket === "already_present_under_different_name") continue;

      const desc = r.rosterStatus?.description;
      const { minor, injured } = rosterStatusFromDescription(desc);
      if (minor) {
        r.bucket = "minors_prospects";
        continue;
      }
      if (injured) {
        r.bucket = "injured_stash";
        continue;
      }

      if (people.active === false) {
        r.bucket = "retired_free_agent_non_roster";
        continue;
      }

      if (r.bucket === "team_mismatch_only") {
        // keep
        continue;
      }

      // If roster status is explicitly Active => active MLB missing
      if (desc && desc.toLowerCase().includes("active")) {
        r.bucket = "active_mlb_missing_from_catalog";
      } else {
        r.bucket = "unknown";
      }
    }
  }

  // Aggregate counts
  const counts: Record<string, number> = {};
  let resolvable = 0;
  let activeResolved = 0;
  let alreadyInCatalog = 0;
  let projectionMissing = 0;
  let mongoMissing = 0;

  for (const r of resolutionResults) {
    if (!r) continue;
    const hasRes = !!r.resolved;
    if (hasRes) resolvable++;
    if (hasRes && r.people?.active) activeResolved++;
    if (r.bucket === "already_present_under_different_name") alreadyInCatalog++;
    if (hasRes && !r.mongoDocExists) mongoMissing++;
    if (hasRes && !r.projectionPresent) projectionMissing++;

    counts[r.bucket] = (counts[r.bucket] || 0) + 1;
  }

  const missingActive = counts["active_mlb_missing_from_catalog"] || 0;

  console.log(JSON.stringify({
    top300_count: top300.length,
    resolvable_to_mlb_id: resolvable,
    active_mlb_among_resolved: activeResolved,
    already_present_under_different_name: alreadyInCatalog,
    counts,
    summary: {
      missingActive,
      projectionMissing,
      mongoMissing,
    },
  }, null, 2));

  // Emit a missing player table (mlbIds not in catalog, resolved or not)
  const missingRows = resolutionResults
    .filter((r) => !!r && r.bucket !== "already_present_under_different_name")
    .map((r, idx) => ({
      vendor_adp: r.vendor.adp,
      vendor_name: r.vendor.name,
      vendor_team: r.vendor.team,
      vendor_position: r.vendor.position,
      resolved_mlb_id: r.resolved?.mlbId ?? null,
      resolved_method: r.resolved?.method ?? null,
      people_active: r.people?.active ?? null,
      current_team_id: r.people?.currentTeam?.id ?? null,
      roster_status: r.rosterStatus ?? null,
      projection_present: r.projectionPresent,
      mongo_doc_exists: r.mongoDocExists,
      bucket: r.bucket,
      // normalized name existence in catalog for team mismatch hint
      normalized_name_in_catalog: catalogNormNameSet.has(normalizePlayerName(r.vendor.name)),
    }));

  // Write to tmp for inspection
  const outPath = path.resolve(process.cwd(), "tmp/audit-market-adp-unmatched-nfbc.json");
  const payload = { missingRows };
  require('fs').mkdirSync(path.dirname(outPath), { recursive: true });
  require('fs').writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\nWrote missingRows to ${outPath}`);
  await mongoose.disconnect().catch(() => undefined);
  // eslint-disable-next-line no-console
  console.log("\nMongo connection closed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
