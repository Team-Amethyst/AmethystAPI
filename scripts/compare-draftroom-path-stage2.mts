/**
 * Compare Stage 1 (prod) vs Stage 2 (candidate) Draftroom-path verification JSON.
 *   node --import tsx scripts/compare-draftroom-path-stage2.mts <stage1.json> <stage2.json>
 */
import { readFileSync } from "node:fs";

const [s1Path, s2Path] = process.argv.slice(2);
if (!s1Path || !s2Path) {
  console.error(
    "Usage: npx tsx scripts/compare-draftroom-path-stage2.mts <stage1.json> <stage2.json>",
  );
  process.exit(1);
}

const s1 = JSON.parse(readFileSync(s1Path, "utf8")) as Record<string, unknown>;
const s2 = JSON.parse(readFileSync(s2Path, "utf8")) as Record<string, unknown>;

const pd1 = (s1.valuation_by_checkpoint as Record<string, unknown>)
  .pre_draft as Record<string, unknown>;
const pd2 = (s2.valuation_by_checkpoint as Record<string, unknown>)
  .pre_draft as Record<string, unknown>;

const TRACKED = [
  "Aaron Judge",
  "Julio Rodríguez",
  "Tarik Skubal",
  "Bobby Witt Jr.",
  "José Ramírez",
  "Vladimir Guerrero Jr.",
  "Gunnar Henderson",
  "Cal Raleigh",
  "Anthony Volpe",
  "Jarren Duran",
  "Riley Greene",
  "Drew Rasmussen",
  "Bryan Woo",
  "Austin Wells",
  "Will Warren",
  "Camilo Doval",
  "Fernando Cruz",
  "Spencer Jones",
];

function normName(n: string) {
  return n.normalize("NFD").replace(/\p{M}/gu, "");
}

function byName(
  pd: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const rows = (pd.deep_dive_players ?? []) as Record<string, unknown>[];
  return rows.find((r) => normName(String(r.name)) === normName(name));
}

const e1 = pd1.engine_meta as Record<string, unknown>;
const e2 = pd2.engine_meta as Record<string, unknown>;
const r1 = (pd1.replacement_values_by_slot ?? {}) as Record<string, number>;
const r2 = (pd2.replacement_values_by_slot ?? {}) as Record<string, number>;

console.log(
  JSON.stringify(
    {
      stage1_meta: {
        draftable_pool_size: e1.draftable_pool_size,
        UTIL: r1.UTIL,
        total_surplus_mass: e1.total_surplus_mass,
        inflation_factor: e1.inflation_factor,
        player_ids_sent: e1.player_ids_sent,
      },
      stage2_meta: {
        draftable_pool_size: e2.draftable_pool_size,
        UTIL: r2.UTIL,
        total_surplus_mass: e2.total_surplus_mass,
        inflation_factor: e2.inflation_factor,
        player_ids_sent: e2.player_ids_sent,
      },
      curve_stage1: pd1.curve_summary,
      curve_stage2: pd2.curve_summary,
      tracked: TRACKED.map((name) => {
        const a = byName(pd1, name);
        const b = byName(pd2, name);
        return {
          name,
          stage1: a ?? null,
          stage2: b ?? null,
        };
      }),
      cap_collision_stage2: ["Bobby Witt Jr.", "José Ramírez", "Vladimir Guerrero Jr."].map(
        (name) => {
          const b = byName(pd2, name);
          return {
            name,
            auction_value: b?.auction_value,
            surplus_basis: b?.surplus_basis,
            replacement_key_used: b?.replacement_key_used,
          };
        },
      ),
    },
    null,
    2,
  ),
);
