# Hangar filter: including and excluding hangars on the GraphQL lists

**Status: ✅ done** — `includeHangar`/`includeHangars` and
`excludeHangar`/`excludeHangars` ship on `assets`, `restock` and `blueprints`
in `schema.graphql.ts`/`resolvers.ts` over the pure seam
`src/app/api/graphql/hangarFlags.ts`, with `test/graphqlHangar.test.ts` and the
`test/graphqlSchema.test.ts` drift guard covering them.

`hangar`/`hangars` was the original spelling of the include pair and still
works verbatim — a Link is a **stored** query that runs untouched whenever a
viewer opens it, so renaming it would have broken every link already saved.
Passing both spellings is refused; they are one filter.

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


## Excluding hangars

Selecting a hangar answers "what is in Deliveries". The other half — "what do I
hold here that ISN'T fuel or already committed to a delivery" — needs the
dimension read the other way, and a Link viewer cannot post-filter, so it has
to be part of the stored query.

`excludeHangar:`/`excludeHangars:` are that pair, resolving through the same
catalog: `"fuel bay"` drops both fuel bays exactly as it would select both.
Its own arguments rather than a negation syntax inside the include pair, for
the reason the schema already splits singular from plural — a stored link is
read by someone a year later, and `excludeHangar: "fuel bay"` says what it does
where a `!` prefix would have to be learned. Naming the include pair
`includeHangar` is the other half of that: `excludeHangar` reads as the
opposite of `includeHangar` and as the opposite of nothing at all next to a
bare `hangar`.

**The two compose, and the overlap is settled before the query.** `includeHangar:
"deliveries", excludeHangar: "corp deliveries"` is a character's delivery hangar
alone; `resolveHangarFilters` subtracts and hands the resolvers one `.in()`
rather than two clauses to AND. An exclusion that removes every hangar the
filter included is an **error** — an empty result there is arithmetic the
caller got wrong, and a link nobody re-reads for a year would just look broken.

**The null trap is the load-bearing detail.** `location_flag` is nullable, and
`location_flag NOT IN (…)` evaluates to NULL for a null flag, so plain SQL
drops those rows. A stack in **no** hangar is not in the fuel bay, and
excluding the fuel bay must keep it — so the exclusion goes through
`location_flag.is.null,location_flag.not.in.(…)`, pinned by a test. That string
is interpolated because PostgREST's `or=` takes one opaque clause, which is
safe only because the values come from the closed catalog and never from the
caller; `hangarFlagsAreBareWords` is the test that keeps a future entry from
ending the list.

Surface: the **Stock, minus fuel and deliveries** link template
(`src/app/link/templates.ts`), which the `/link` picker, the `/graphql`
examples and the MCP `link_schema` examples all read from that one list.
