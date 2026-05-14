# Valuation dollar ladder (product + integrators)

Four **nominal auction-dollar** fields on each `valuations[]` row are **one pipeline**, not four interchangeable “prices.” Use this page for **UI hierarchy**, **grader narratives**, and **comparisons to other draft tools**.

Technical audit: [valuation-response-field-audit.md](valuation-response-field-audit.md). Inflation math: [valuation-inflation-semantics.md](valuation-inflation-semantics.md). Code map: [valuation-module-map.md](valuation-module-map.md).

---

## The ladder (read top → bottom)

| Step | Field | Question it answers |
|------|--------|---------------------|
| 1 | **`baseline_value`** | How strong is this player **for this scoring and roster construction**, before **this league’s** remaining-cash math? (Already includes projection + embedded scarcity from the baseline engine — **not** raw catalog `value`.) |
| 2 | **`auction_value`** | **Canonical official dollar valuation** for evaluation and benchmarks — always **`adjusted_value`** (league-wide auction dollars from the active **`inflation_model`**; default **`replacement_slots_v2`**). |
| 3 | **`adjusted_value`** | Same dollar economics as **`auction_value`** (league-wide auction target); retained for compatibility and formulas (`inflation_adjustment`, explainability). |
| 4 | **`recommended_bid`** | Draftroom **bid suggestion** for live UX (phase, depth, smoothing) — **not** the canonical valuation; use **`auction_value`** when you need one primary dollar per player. |
| 5 | **`team_adjusted_value`** | **Team-context only:** marginal worth **to the requesting team’s** open slots, budget pressure, and replacement picture — not a universal cross-league price. |
| 6 | **`edge`** | **`team_adjusted_value − recommended_bid`** — room vs the suggested bid (positive ≈ “more value to you than we suggest paying”). |

**`explain_v2`:** `list_value` / `auction_target` align with **`baseline_value`** / **`adjusted_value`** (and **`auction_value`**); drivers and `why[]` carry the story into UI without reverse-engineering math.

---

## Which number is “primary”?

| Surface | Suggested headline | Supporting |
|--------|-------------------|------------|
| External evaluation / leaderboards / one dollar per player | **`auction_value`** | `adjusted_value` (identical), `inflation_model`, `context_v2.market_summary` |
| Live draft / bid box | **`recommended_bid`** | `team_adjusted_value`, `edge` |
| “Fair market” / model transparency | **`auction_value`** / **`adjusted_value`** | `baseline_value`, top-level inflation + `context_v2.market_summary` |
| Roster-fit / optimizer framing | **`team_adjusted_value`** | **`auction_value`**, slot alerts from `context_v2` |

Showing **all four** at once without a ladder label invites “spreadsheet shock.” Prefer **one headline** plus expand / tooltip.

---

## How this compares to typical draft assistants

Many tools collapse everything into **one dollar column** (sometimes mixing “value” and “bid” without saying which). Amethyst **splits**:

- **List / build context** (`baseline_value`) vs **official auction dollars** (`auction_value` / `adjusted_value`) vs **draftroom bid suggestion** (`recommended_bid`) vs **your roster context** (`team_adjusted_value`).

**When yours looks good in a side-by-side:** lead with **transparency** (same request → reproducible ladder + `explain_v2` / `why`), **slot-aware surplus allocation** when `inflation_model` is `replacement_slots_v2` (UI label: surplus allocation factor, not a simple inflation index), and **monotone bid curves** within position after smoothing — not with “our single number is always higher.” **When to be humble:** other products may use different projections or ADP sources; your **`indicator`** (Steal / Reach / Fair) is defined vs **your** catalog `adp`, not “the industry.”

---

## Market ADP vs `auction_value` (policy)

**`auction_value`** (same as **`adjusted_value`**) is the engine’s **model fair value** under the active inflation model: league-wide **surplus-based auction dollars** from baseline strength above replacement and remaining league cash. It is **not** “what the external draft market will pay this week,” and it is **not** an NFBC price oracle.

**`market_adp`** on a row (when populated from a real vendor feed — see [market-adp-ingestion.md](market-adp-ingestion.md)) is **external draft-market context** for transparency, ordering, and UI. It is **not** an input to the **`auction_value`** formula. **Do not treat `market_adp` as a formula driver** without a separate product policy, explicit tuning, and **budget rescaling**; naive blends (for example, pulling **`auction_value`** toward **`recommended_bid`**) can create **large budget drift** relative to the surplus-cash identity.

**Large gaps** between **`auction_value`** and early **`market_adp`** are **expected** when (1) **projection / playing-time** in Mongo is conservative vs what drafters pay for; (2) **replacement pressure** shrinks **surplus_basis** for fungible positions; or (3) the market prices **upside or recovery risk** that the baseline does not fully encode.

**`recommended_bid`** (and any UI “max bid” derived from it) remains the **strategic ceiling / draft anchor**: phase- and depth-aware, and by design it **can sit materially above `auction_value`** when list strength exceeds surplus-deflated auction targets (see [valuation-inflation-semantics.md](valuation-inflation-semantics.md) — *recommended_bid vs auction_value*). Use **`recommended_bid`** for live bidding discipline; use **`auction_value`** for benchmarks and model transparency.

**Current decision:** Do **not** blend **`market_adp`** into **`auction_value`**. Keep **`market_adp`** as **context** only. A future **small ADP-informed tilt** would require its own design, **budget rescaling**, and a clear product definition before any formula change.

---

## Invariants (regression-backed)

The engine maintains (see `test/valuationDollarLadder.test.ts`, `test/valuationCanonicalEvaluation.test.ts`):

- **`auction_value` = `adjusted_value`** on each row (canonical alias for evaluation).
- **`inflation_adjustment` ≈ `adjusted_value − baseline_value`** on each row.
- **`edge` ≈ `team_adjusted_value − recommended_bid`** (symmetric league and post–explainability paths).
- **`recommended_bid`**, after smoothing, is **non-increasing** when rows are sorted by **`baseline_value`** descending **within** hitters and **within** pitchers separately.

---

## Maintenance rule

If you change **`recommendedBidConfig`** or team-adjusted multipliers, update **this file’s table** only when the **meaning** of a column changes; tune numeric stories belong in code comments + [valuation-module-map.md](valuation-module-map.md).
