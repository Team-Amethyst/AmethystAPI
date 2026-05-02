# Valuation dollar ladder (product + integrators)

Four **nominal auction-dollar** fields on each `valuations[]` row are **one pipeline**, not four interchangeable “prices.” Use this page for **UI hierarchy**, **grader narratives**, and **comparisons to other draft tools**.

Technical audit: [valuation-response-field-audit.md](valuation-response-field-audit.md). Inflation math: [valuation-inflation-semantics.md](valuation-inflation-semantics.md). Code map: [valuation-module-map.md](valuation-module-map.md).

---

## The ladder (read top → bottom)

| Step | Field | Question it answers |
|------|--------|---------------------|
| 1 | **`baseline_value`** | How strong is this player **for this scoring and roster construction**, before **this league’s** remaining-cash math? (Already includes projection + embedded scarcity from the baseline engine — **not** raw catalog `value`.) |
| 2 | **`adjusted_value`** | What is the **league-wide** auction target from the active **`inflation_model`** (`global_v1`, `surplus_slots_v1`, or `replacement_slots_v2`)? |
| 3 | **`recommended_bid`** | What **bid anchor** should a human use, given draft **phase**, **depth**, position rules, and **isotonic smoothing** within hitters vs pitchers? |
| 4 | **`team_adjusted_value`** | What is the player worth **to the requesting team’s** open slots, budget pressure, and replacement picture? |
| 5 | **`edge`** | **`team_adjusted_value − recommended_bid`** — room vs the suggested bid (positive ≈ “more value to you than we suggest paying”). |

**`explain_v2`:** `list_value` / `auction_target` align with **`baseline_value`** / **`adjusted_value`**; drivers and `why[]` carry the story into UI without reverse-engineering math.

---

## Which number is “primary”?

| Surface | Suggested headline | Supporting |
|--------|-------------------|------------|
| Live draft / bid box | **`recommended_bid`** | `team_adjusted_value`, `edge` |
| “Fair market” / model transparency | **`adjusted_value`** | `baseline_value`, top-level inflation + `context_v2.market_summary` |
| Roster-fit / optimizer framing | **`team_adjusted_value`** | `adjusted_value`, slot alerts from `context_v2` |

Showing **all four** at once without a ladder label invites “spreadsheet shock.” Prefer **one headline** plus expand / tooltip.

---

## How this compares to typical draft assistants

Many tools collapse everything into **one dollar column** (sometimes mixing “value” and “bid” without saying which). Amethyst **splits**:

- **List / build context** (`baseline_value`) vs **league clearing mechanics** (`adjusted_value`) vs **human bid policy** (`recommended_bid`) vs **your roster** (`team_adjusted_value`).

**When yours looks good in a side-by-side:** lead with **transparency** (same request → reproducible ladder + `explain_v2` / `why`), **slot-aware inflation** when `inflation_model` is `replacement_slots_v2`, and **monotone bid curves** within position after smoothing — not with “our single number is always higher.” **When to be humble:** other products may use different projections or ADP sources; your **`indicator`** (Steal / Reach / Fair) is defined vs **your** catalog `adp`, not “the industry.”

---

## Invariants (regression-backed)

The engine maintains (see `test/valuationDollarLadder.test.ts`):

- **`inflation_adjustment` ≈ `adjusted_value − baseline_value`** on each row.
- **`edge` ≈ `team_adjusted_value − recommended_bid`** (symmetric league and post–explainability paths).
- **`recommended_bid`**, after smoothing, is **non-increasing** when rows are sorted by **`baseline_value`** descending **within** hitters and **within** pitchers separately.

---

## Maintenance rule

If you change **`recommendedBidConfig`** or team-adjusted multipliers, update **this file’s table** only when the **meaning** of a column changes; tune numeric stories belong in code comments + [valuation-module-map.md](valuation-module-map.md).
