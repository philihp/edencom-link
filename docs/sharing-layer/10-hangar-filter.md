# Hangar filter: `hangar:` / `hangars:` on the GraphQL lists

**Status: ✅ done** — `hangar`/`hangars` ship on `assets`, `restock` and
`blueprints` in `schema.graphql.ts`/`resolvers.ts` over the pure seam
`src/app/api/graphql/hangarFlags.ts`, with `test/graphqlHangar.test.ts` and the
`test/graphqlSchema.test.ts` drift guard covering them.

## Context

A Link could already ask "what do I have **at** TK-DLH" (`location:`), but not
"what is sitting **in** the Deliveries hangar" — the compartment a stack sits
in, which is what tells you a courier dropped something off and nobody has
unpacked it. The column was always in the response (`Asset.locationFlag`,
`Blueprint.locationFlag`); there was simply no way to filter on it, and a Link
viewer cannot post-filter — a Link renders whatever its stored query returns.

`location_flag` is ESI's raw token, stored verbatim by the extract jobs
(`Deliveries`, `CorpDeliveries`, `CorpSAG1`…`CorpSAG7`, `DroneBay`, …). Two
things make it unlike every other filter dimension:

- **There is no directory to resolve a name against.** Types have the SDE,
  locations have the structure caches, owners have the caller's registrations.
  Flags have nothing — no table, no view, no ESI endpoint.
- **A character's Deliveries hangar and a corporation's are different
  tokens.** `Deliveries` vs `CorpDeliveries`. Someone asking for "deliveries"
  means both, and can't be expected to know either token exists.

## Design

`hangarFlags.ts` carries the catalog — flag token, the label the site would use,
and the aliases people type — and **the catalog is the directory**. It follows
the schema's singular/plural stance unchanged (`filters.ts`):

- `hangar:` — case-insensitive **substring** over token, label and aliases,
  keeping every flag it matched. `"deliveries"` → `Deliveries` **and**
  `CorpDeliveries`; `"corp hangar"` → all seven divisions.
- `hangars:` — an **exact** list of whole tokens, labels or aliases, mixed. One
  entry may still resolve to several flags (the `Deliveries` alias sits on both
  delivery hangars), the way an exact location name can name two stations.
- The two are mutually exclusive, and an entry matching nothing is an **error**
  listing the catalog — never a silently empty hangar, which is what a typo
  would otherwise look like.

That last rule makes the catalog load-bearing: a flag missing from it cannot be
filtered by, so a bay worth filtering gets an entry there and a line in the
test. The alternative — passing an arbitrary string straight to
`.in('location_flag', …)` — accepts anything and returns nothing for a typo,
which for a link nobody re-reads for a year is the worse failure.

The resolvers push it down as one more `.in()` on the same builder the type and
location filters use, on both owner sides, on the head-count and the row pages
alike. It is on the three lists whose rows carry a flag — `assets`, the
`restock` sum over them, and `blueprints`; an order, a job or a transaction
names a place, not a compartment.

## Surfaces

- `assets(hangar: "Deliveries")` — the **Deliveries hangars** link template
  (`src/app/link/templates.ts`), offered by the `/link` picker, the `/graphql`
  examples and the MCP `link_schema` examples, since all three read that list.
- `restock(hangar: …)` — narrows which hangars count as "on hand", so a buffer
  can be measured over a staging division rather than everything you own.
