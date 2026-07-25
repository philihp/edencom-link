# edencom.link MCP — Tool Gaps and Specifications

Status: proposed
Owner: philihp

## Why this exists

Four questions were asked of the MCP server in a single session. Three of them
could not be answered with the tools as they exist, and were resolved by running
raw SQL against Supabase instead:

1. "Do I still have a Phoenix Navy Issue?" — answerable, but took three calls
   (`search_assets`, `list_market_orders`, `search_transactions`).
2. "Given how many capital launcher hardpoints, how many Phoenix Navy Issues
   could I build?" — five calls plus manual diffing of a BOM against asset
   counts. The binding constraint (Capital Siege Array) and the fact that *no
   Phoenix Navy Issue blueprint is owned at all* were both found by accident
   rather than by design.
3. "Which blueprints in 27-HP0 are not at ME/TE 10/20 yet?" — impossible.
   `list_blueprints` has no location filter and truncates at 200 of 10,968 rows.

The gaps are not exotic. They are: **scoping**, **aggregation**, and
**derived answers**. This document specifies four tools (two new, one extended,
one new read-only helper) plus one data-integrity investigation.

Each numbered section below is intended to be a self-contained Claude Code
request. Sections 1 and 3 are prerequisites for 2 and 4.

---

## Ground truth: schema and conventions

Recorded here so implementations don't have to re-derive it.

### Relevant tables (`public` schema)

| Table | Notes |
|---|---|
| `character_blueprint` | `item_id`, `character_id` (uuid), `type_id`, `location_id`, `location_flag`, `quantity`, `material_efficiency` (smallint), `time_efficiency` (smallint), `runs`, `is_current`, `valid_from`, `valid_until` |
| `corp_blueprint` | same shape, `corporation_id` (bigint) instead of `character_id` |
| `character_asset`, `corp_asset` | asset hangars |
| `universe_structure` | `structure_id`, `name`, `system_id`, `type_id`, `resolved_at` — resolved Upwell names |
| `corp_structure` | `structure_id`, `corporation_id`, `type_id`, `system_id`, `name`, `state`, `services` (jsonb), reinforce fields |
| `corp_structure_rig` | fitted rigs, needed for ME calculations |
| `sde_types` | `_key` = type_id, `data` jsonb; English name at `data->'name'->>'en'` |
| `sde_groups` / `sde_group` | needed to classify blueprints vs reaction formulas |
| `sde_blueprints` | manufacturing/reaction material bills |
| `sde_map_solar_systems` | `_key` = system_id, `data` jsonb |

Both blueprint tables are temporal — **always filter `is_current`**. There is a
parallel `*_over_time` table for history; don't read from it for current-state
questions.

### ESI encoding traps

- `runs = -1` means the row is a **BPO** (original). Any other value is a BPC
  with that many runs remaining.
- `quantity = -1` means a singleton (unstacked) item. `quantity = -2` means a
  BPC stack. **Do not `sum(quantity)`** — it produces negative nonsense. Count
  rows, or handle the sentinel values explicitly.
- **Reaction formulas cannot be researched.** They have no ME/TE, always report
  0/0, and will flood any "needs research" result set. Exclude them by
  `group_id` via `sde_types` → `sde_groups`, *not* by matching `'%Reaction
  Formula%'` against the name. Name matching is what the exploratory SQL did and
  it is fragile.
- BPOs of researchable types cannot stack; reaction formula originals can. This
  is why some `runs = -1` rows have positive quantities.

### Reference numbers for tests

As of 2026-07-25, scoped to system 27-HP0 (`system_id` 30000832), which contains
8 resolved structures:

- 884 current blueprint rows total
- 280 originals (`runs = -1`)
- 18 originals below ME 10 / TE 20 *after* excluding reaction formulas
  (was 32 before exclusion — the 14 extras are the trap)

These make good fixture assertions, though they will drift as research
completes. Prefer asserting on shape and on relative filtering behaviour rather
than on absolute counts.

---

## 1. Extend `list_blueprints` — scoping, filtering, grouping

**Priority: first.** Sections 2 and 4 depend on this landing.

The current signature is `{ item?, owner? }`, and the response truncates with a
note reading `"Showing the first 200 of 10968 blueprints"`. This makes it unable
to answer any location-scoped or research-status question. The truncation note
also suggests the current implementation fetches broadly and slices in JS.

### Proposed signature

```ts
type ListBlueprintsInput = {
  item?: string           // name substring, matches product name too
  owner?: string          // character or corporation name substring
  system?: string         // e.g. "27-HP0"
  structure?: string      // e.g. "HDUMP - T1 Research" (substring of resolved name)
  kind?: 'original' | 'copy' | 'all'   // default 'all'
  below_me?: number       // return only blueprints with me < this
  below_te?: number       // return only blueprints with te < this
  researchable?: boolean  // exclude reaction formulas and other non-researchable types
  group?: 'none' | 'type' | 'type_location'  // default 'none'
  limit?: number          // default 100, max 500
}
```

### Behaviour requirements

- **All filtering, grouping, and limiting happens in SQL.** Do not fetch 10k
  rows and post-process. This is the actual defect being fixed.
- `system` and `structure` resolve through `universe_structure`. Note that
  `location_id` may be a container *inside* a structure rather than the
  structure itself — for now, match on `location_id = structure_id` and record
  a known limitation; container traversal is out of scope for this change.
- `group: 'type'` collapses identical (type, me, te) rows into one with a
  count. This is the fix for the 37-identical-Phoenix-BPC noise.
- `below_me` / `below_te` are OR'd when both are given (that is: "short of
  either target"), matching how the question is actually asked. Document this
  explicitly in the tool description because it is not the obvious reading.
- When results are truncated, say what the filter was and suggest a narrowing
  parameter. The current note gives the agent nothing to act on.

### Tests (node:test)

- `system` scoping returns only 27-HP0 rows
- `kind: 'original'` excludes all `runs <> -1`
- `below_me: 10` with `researchable: true` excludes reaction formulas
- `group: 'type'` collapses a known duplicate stack and the counts sum to the
  ungrouped row count
- `limit` is enforced in SQL (assert on generated query or row count, not on
  a sliced array)

---

## 2. New tool: `research_backlog`

Answers "what still needs research" directly, so the agent doesn't reconstruct
it from filters every time.

```ts
type ResearchBacklogInput = {
  system?: string
  structure?: string
  owner?: string
  target_me?: number   // default 10
  target_te?: number   // default 20
}

type ResearchBacklogRow = {
  blueprint: string
  type_id: number
  me: number
  te: number
  me_to_go: number
  te_to_go: number
  structure: string
  system: string
  in_progress: boolean   // an active ME/TE research job exists for this item_id
}
```

### Behaviour requirements

- Originals only. BPCs cannot be researched; including them is a bug.
- Non-researchable types excluded by group, per the traps section above.
- `in_progress` joins against industry jobs so the agent doesn't recommend
  re-queuing something already running. During the exploratory session, several
  ME/TE jobs were active; without this flag the backlog list is misleading.
- Sort by remaining work descending by default (`me_to_go + te_to_go`), since
  the practical follow-up is always "what should I queue first".

### Nice-to-have, defer if it complicates

A `runs_pending` or `usage_rank` field — the three fuel block BPOs at ME 0 matter
far more than an Amarr Shuttle BPO at ME 0, because thousands of fuel block runs
are queued against them. Ordering by actual usage would make the tool
prescriptive rather than merely descriptive. Can be a follow-up.

---

## 3. New tool: `list_structures`

**Priority: first, alongside section 1.** Small, unblocks things.

Reading `universe_structure` directly was necessary just to learn which stations
exist in 27-HP0. It's also the missing piece that lets `blueprint_for_product`'s
existing `structure_id` parameter be used without the caller guessing IDs.

```ts
type ListStructuresInput = {
  system?: string
  name?: string
  owner?: string
  services?: string[]   // filter by fitted/online service, e.g. ['manufacturing']
}

type StructureRow = {
  structure_id: number
  name: string
  system: string
  type: string            // "Sotiyo", "Athanor", ...
  state?: string
  services?: string[]
  rigs?: string[]         // from corp_structure_rig
}
```

**`me_bonus` was specified here, built, and then removed — don't add it back.**
The idea was that it explains *why* a material requirement came out at 18
instead of 20. It can't: a rig only bonuses products in the groups its filter
covers (`src/app/blueprint/rigs.ts`), so there is no single material bonus for a
structure independent of what is being built. A structure carrying only an
Equipment Manufacturing rig has an `me_bonus` of zero for a ship and 2.4% for a
module, and the field cannot say which. It was also a second hand-rolled copy of
arithmetic that belongs to `eve-industry`'s `cost()`.

The rigs *are* the fact worth returning, and this tool returns them. To explain a
material requirement, pass the row's `structure_id` to `blueprint_for_product` or
`blueprints_using_material`: those know the product, apply the per-product rig
test, and report which rig was used and which were skipped. `rigs_for_blueprint`
answers the applicability question on its own.

---

## 4. New tool: `build_readiness`

The Phoenix Navy Issue question, as one call.

```ts
type BuildReadinessInput = {
  product: string
  runs?: number          // default 1
  structure_id?: string  // derives ME modifiers, as blueprint_for_product does
  owner?: string
  system?: string        // only count materials present here
}

type BuildReadiness = {
  product: string
  max_buildable: number
  blueprint: {
    owned: boolean
    kind?: 'original' | 'copy'
    me?: number
    te?: number
    runs_remaining?: number
    location?: string
  }
  binding_constraint: string | null   // material name that caps max_buildable
  materials: Array<{
    material: string
    need_per_run: number
    need_total: number
    have: number
    short: number
    locations: string[]
    in_production: number   // quantity from active industry jobs
  }>
}
```

### Behaviour requirements

- `max_buildable` is `min(floor(have / need_per_run))` across all materials, and
  is **0 if no blueprint is owned**. `blueprint.owned: false` is the single most
  important field here — the session's answer of "12" was arithmetically right
  about hardpoints and practically wrong, because no PNI blueprint exists and
  only 4 of the 18 required Capital Siege Arrays were on hand.
- `binding_constraint` names the material that caps the number. This is the
  thing a human actually wants and it should not require reading a table.
- `in_production` catches the common case where a component is mid-build. During
  the session, checking whether siege arrays were queued required scanning 250
  industry jobs by eye.
- Apply EVE's per-job material rounding, not per-unit:
  `max(runs, ceil(base × runs × me_mult × structure_mult × rig_mult))`, with the
  rig multiplier scaled by system security (nullsec ×2.1). `blueprint_for_product`
  already does this — share the code, don't reimplement.
- Materials are matched against character *and* corporation hangars, same as
  `search_assets`.

### Tests

- No blueprint owned → `max_buildable: 0`, `blueprint.owned: false`
- A single scarce material sets `binding_constraint` correctly
- ME modifiers change `need_per_run` (20 → 18 for a Phoenix Navy Issue at ME 9
  with a T2 rig in nullsec)
- `system` scoping excludes materials in other systems

---

## 5. Investigate: non-blueprint rows in `character_blueprint`

Separate from the tool work. Do not let this block sections 1–4.

Querying originals in 27-HP0 returned three item types that are salvage, not
blueprints:

- Malfunctioning Power Cores
- Wrecked Thruster Sections
- Wrecked Armor Nanobot

They appear with `runs = -1` and positive quantities. Possible explanations,
roughly in order of likelihood:

1. The ESI `/characters/{id}/blueprints/` response is being merged with an asset
   or salvage response somewhere in the pipeline, and rows are landing in the
   wrong table.
2. A `type_id` join is misaligned — the ingest is correct but `sde_types` is
   being keyed against the wrong column, so real blueprints are being *labelled*
   as salvage.
3. ESI genuinely returns these (unlikely, but worth ruling out before assuming
   it's our bug).

Hypothesis 2 is cheap to test and would be the more alarming finding, since it
would mean other blueprint names in the dataset are also wrong. Check that
first: pick one of the three rows, take its `item_id`, and confirm what ESI
reports for it directly.

If it turns out to be an ingest bug, `research_backlog` should still defensively
filter to types that are actually in a blueprint group, rather than trusting the
table's name.

---

## Suggested sequencing

| Request | Contents | Depends on |
|---|---|---|
| A | Sections 1 + 3 — `list_blueprints` filters, `list_structures` | — |
| B | Sections 2 + 4 — `research_backlog`, `build_readiness` | A |
| C | Section 5 — salvage row investigation | — |

A is mechanical and should land quickly. B contains the real logic and deserves
its own review. C is independent and might turn out to be somebody else's bug.

## Conventions for implementation

- No semicolons.
- Functional and point-free where it reads well; `map`/`reduce` over loops.
- Named Ramda imports (`import { pluck } from 'ramda'`), never `import * as R`.
- Tests with `node:test`.
- Follow the existing tool registration pattern in the MCP route; match how
  `search_assets` handles its `system` filter rather than inventing a second
  approach.
- Annotate all four tools `readOnlyHint: true`.
