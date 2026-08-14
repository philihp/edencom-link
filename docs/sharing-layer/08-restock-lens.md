# Restock lens: `restock` GraphQL root field

**Status: ✅ done** — `restock` ships in `schema.graphql.ts`/`resolvers.ts`
over the pure seam `restock.ts`, with `test/graphqlRestock.test.ts` and the
`test/graphqlSchema.test.ts` drift guard covering it.

One amendment to the design below: the line carries **both** computed columns,
not just `toBuy`. `delta` is signed (`onHand - target`, negative when short) so
overstock reads as readily as shortfall; `toBuy` is the clamped shopping
number. They only disagree above target, which is exactly where a lens author
wants the choice.

## Context

Goal: a **shareable lens** that tells its audience "here's what I want to buy" — for each item
type with a desired supply-buffer target, when on-hand stock falls below the target, show
`toBuy = target - onHand`.

This is not expressible in the GraphQL schema today: it has no aggregation (assets return raw
stacks), no arithmetic, and no quantity thresholds. The change is purely additive to the
hand-written schema (`src/app/api/graphql/schema.graphql.ts` + `resolvers.ts`); lenses pick up
any new root field automatically, since `validateLensQuery` (`src/app/lens/validate.ts`) only
enforces one-operation / one-top-level-field / no-session-only.

Decisions:

- **Targets live in the lens's frozen `variables` jsonb** — no new table, no migration. Viewers
  cannot change variables, so the buffer levels are always the creator's.
- **Stock scope is filterable** via the existing owner/location filter pairs, defaulting to
  everything the caller owns (character + corp assets).

## Changes

### 1. New pure seam — `src/app/api/graphql/restock.ts` (new file, no I/O)

- `resolveTargets(raw, candidatesFor)` — resolve `{type, quantity}` entries: bare integer →
  typeId; name → exactly one whole-name match (same matching stance as `filters.ts`); refusals
  for: empty targets, non-positive/non-integer quantity, unmatched name, ambiguous name (list
  candidates), duplicate resolved typeId across targets.
- `restockLines(targets, stacks, onlyBelowTarget)` — ramda fold summing `quantity ?? 1` per
  `type_id`, producing `{typeId, target, onHand, delta: onHand - target, toBuy: max(0, target -
  onHand)}` in target input order; `onlyBelowTarget` drops covered lines (default true).

### 2. SDL — `src/app/api/graphql/schema.graphql.ts`

Add to `Query` (after `assets`):

```graphql
restock(
  targets: [RestockTarget!]!
  location: String
  locations: [String!]
  owner: String
  owners: [String!]
  onlyBelowTarget: Boolean = true
): [RestockLine!]!
```

Plus `input RestockTarget { type: String!  quantity: Int! }` and:

```graphql
type RestockLine {
  typeId: String!
  typeName: String
  groupName: String
  target: String!
  onHand: String!
  "onHand - target; negative when short."
  delta: String!
  "max(0, target - onHand) — what to buy."
  toBuy: String!
  type: ItemType!
}
```

- Plain list, no Page wrapper (row count bounded by target count, like `marketOrders`).
- Quantities are `String!` on output (matches `Asset.quantity` — sums can exceed 2^31); `Int!`
  on input, ceiling documented in the docstring.
- **No owner block** — first aggregate row type; a line summed across characters + a corp hangar
  has no single owner. Per-owner breakdown is answered by the `owner:` filter instead.
- Only object edge is `type: ItemType!` (entity types stay leaf-only → CSV flattening stays one
  line per row).
- No `includeShared` (shared rows would double-count; keeps the field lens-safe with zero
  `validate.ts` changes).

### 3. Resolver — `src/app/api/graphql/resolvers.ts`

New `Query.restock`, reusing existing helpers (`ownerScopesFor`, `locationIdsFor`, `typesFor`,
`typeNameOf`, `itemTypeOf`, `fetchCapped`, `badRequest`, `queryFailed`, `ASSET_CAP`):

1. Resolve target names via `searchSdeTypesAll` per name → feed `resolveTargets`; bad input →
   `badRequest`.
2. One `typesFor(targetTypeIds)` batch serves line names, the `ItemType` edge, and
   existence-checking bare-id targets (unknown SDE id → error, not a phantom zero-stock line).
3. **Targeted read, not the assets machinery**: query `character_asset` (by `registration_id`)
   and `corp_asset` (by `corporation_id`) selecting only `type_id, quantity`, filtered
   `.in('type_id', targetTypeIds)` + optional `.in('location_id', locationIds)` + the mandatory
   `.in(ownerColumn, ownerIds)` leak guard (critical — lenses run token-mode via
   `contextForUser`). This avoids the `ASSET_CAP=5000` truncation distorting sums.
4. Belt-and-braces: `head:true` count check first; if filtered stacks would exceed `ASSET_CAP`,
   refuse with a "narrow the filters" 400 rather than sum a truncated read.
5. Fold via `restockLines`, map to strings.

### 4. Tests

- **New `test/graphqlRestock.test.ts`** over the pure seam: multi-stack/multi-source summation,
  null quantity counts as 1, `toBuy` clamped at 0, `onlyBelowTarget` both ways, input-order
  preservation, all refusal cases (including duplicate type spelled once by name and once by id).
- **Update `test/graphqlSchema.test.ts`** (the drift guard): add `restock` to the expected Query
  fields; add it to the owner-filter loop and the `dimensions` map as `['location', 'owner']`
  (no type pair — targets carry the types); do **not** add `RestockLine` to `ROW_TYPES`
  (aggregates carry no owner — add a comment); new assertions: `RestockTarget` input shape,
  `targets: [RestockTarget!]!`, `onlyBelowTarget` default `true`, `RestockLine`'s only object
  field is `type: ItemType!`.

### 5. Discoverability — `src/app/api/mcp/lensTools.ts` + docs

- Append a fourth `EXAMPLES` entry:
  `query Restock($targets: [RestockTarget!]!) { restock(targets: $targets) { typeName groupName target onHand toBuy } }`
  with variables `{ targets: [{ type: "Nitrogen Fuel Block", quantity: 10000 }, ...] }`.
- **Fix confirmed drift in the same touch**: the three existing examples still use pre-pairing
  arg names `locationId:`/`typeIds:` which no longer exist in the schema — they would fail the
  `create_lens` preflight today. Rewrite them to the current `location:`/`types:` args.
- Short "restock" subsection in `docs/sharing-layer/04-graphql-shared.md` (targets frozen in
  variables; aggregate rows carry no owner; token-mode safe).

## End-to-end usage

1. With the `graphql` + `lens` flags, run in `/graphql`:

   ```graphql
   query Restock($targets: [RestockTarget!]!) {
     restock(targets: $targets, location: "1DQ1-A") {
       typeName
       groupName
       target
       onHand
       delta
       toBuy
     }
   }
   ```

   variables
   `{ "targets": [ { "type": "Nitrogen Fuel Block", "quantity": 10000 }, { "type": "34", "quantity": 1000000 } ] }`.

2. Save as a lens (editor at `/lens`, or MCP `create_lens` — its preflight runs the query, so a
   bad target name is refused at save time).
3. Share: corp/alliance audience (RLS `share_audience_matches`) at `/lens/<id>`, or signed link
   `/lens/<id>?share=…`; spreadsheet via `/lens/<id>/csv?share=…`.

## Verification

- `pnpm run lint`, `pnpm test` (new + updated suites), `pnpm run build` (the typecheck).
- Manual: the `/graphql` editor flow above, cross-checking sums against `/asset`; then create a
  link-shared restock lens and open `/lens/<id>?share=…` signed out.

## Sequencing

1. `restock.ts` seam + `test/graphqlRestock.test.ts`
2. SDL + `test/graphqlSchema.test.ts`
3. Resolver
4. `lensTools.ts` examples (incl. drift fix) + docs
5. Lint / test / build; manual check
