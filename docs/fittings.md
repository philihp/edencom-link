# Plan: saved ship fittings (`/fitting`)

Extract the ship fittings players have saved in the game client, list them on
a page, and open any one of them in the eveship.fit viewer the `/ship/[itemId]`
page already renders.

Three PRs, in order: **grant the scope**, **extract the data**, **build the
page**.

---

## Read this first: ESI has no corporation or alliance fittings endpoint

This feature was asked for as "the fittings saved in the game as **corp or
alliance** fittings." That is not something ESI can currently give us, and the
gap is not one we can close from this side.

The fitting window in the client has Personal / Corporation / Alliance tabs.
ESI exposes only the first one:

| Endpoint                                | Scope                            | Notes                             |
| --------------------------------------- | -------------------------------- | --------------------------------- |
| `GET /characters/{id}/fittings`         | `esi-fittings.read_fittings.v1`  | The character's **personal** fits |
| `POST /characters/{id}/fittings`        | `esi-fittings.write_fittings.v1` | Save a fit (we don't write)       |
| `DELETE /characters/{id}/fittings/{id}` | `esi-fittings.write_fittings.v1` | Delete a fit (we don't write)     |

Verified against CCP's current OpenAPI document (`esi.evetech.net/meta/openapi.json`)
and the legacy `/latest/swagger.json`: **`fitting` appears in exactly those two
paths in both.** There is no `/corporations/{id}/fittings`, no
`/alliances/{id}/fittings`, no corporation- or alliance-fittings scope, and the
character response carries no folder/owner discriminator that would let us tell
a copied doctrine fit from a personal one:

```jsonc
{
  "fitting_id": 1,
  "name": "Doctrine Hurricane",
  "description": "",
  "ship_type_id": 24702,
  "items": [{ "type_id": 2048, "flag": "LoSlot0", "quantity": 1 }],
}
```

**So what we build extracts personal fittings, per character, for every
character a player has linked.** In practice this covers most of the intent: a
pilot who flies a corp doctrine almost always has that fit saved personally
(the client's "copy to personal" is one click), and a player linking their
director alt gets that alt's whole doctrine library. What it cannot do is show
a corp fit nobody on the account has personally saved.

The schema below is therefore built with an `owner_scope` column
(`character` today) so that if CCP ever ships a corp/alliance fittings
endpoint, ingesting it is a new job writing a new `owner_scope` value into the
same table, plus a filter on the page — not a migration of everything.

A follow-up plan now exists for going beyond read-only entirely:
[`fitting-paging.md`](fitting-paging.md) — using the write scope to page fits
between the game's 500-slot saved list and an unbounded library here.

**Shipped follow-up: per-fit public share links.** A fit's own page
(`/fitting/[characterId]/[fittingId]`) carries a "Share this fit" control
that mints a `character_fitting_share` row — `token text primary key`,
`(character_id, fitting_id)` — and rewrites the browser's own address bar to
`?token=…`, exactly what gets handed to someone else. Visiting that URL with
the token needs no login: it resolves anonymously through the service-role
client (`src/app/fitting/access.ts`), mirroring `shared_asset_token`'s
`/ship/[itemId]?token=…` pattern precisely, down to the token being minted
with `randomBytes(16).toString('hex')` and owned/revoked under the same RLS
shape. The share points at the fit's live `(character_id, fitting_id)` pair
rather than a copy — an edit in the client is visible through an outstanding
link too, and there's nothing to keep in sync. (An earlier version of this
follow-up published fits into corp/alliance audiences via a `shared_fitting`
snapshot-copy table with its own route shape; that was replaced by the
simpler per-fit link before it shipped.) The `owner_scope` column on
`character_fitting_over_time` remains reserved for a real ESI corp/alliance
endpoint, should CCP ever ship one.

---

## PR 1 — request the `esi-fittings.read_fittings.v1` scope

Smallest possible change, shipped on its own so players can start granting the
scope while PRs 2 and 3 are still in review. A token's scopes are fixed at
issue time, so the extract job in PR 2 sees nothing until a player re-adds
their characters — the earlier this lands, the more data PR 2 has on day one.

- `src/app/character/scopes.ts` — one new `esiScopes` entry. Everything else
  derives from that list: `defaultScopes` (what a player with no saved
  preferences is asked for), `optionalScopes` (the settings-page checkbox),
  and `sso.ts`'s request set.
- This doc.

No table, no job, no UI. The scope is optional like every other non-`publicData`
scope, so declining it costs a player only this feature.

## PR 2 — extract fittings into `character_fitting_over_time`

### Table

SCD Type 2, the house pattern for anything ESI reports as a full snapshot
(`character_blueprint_over_time`, `character_mercenary_den_over_time`). A
fitting is edited in place in the client — same `fitting_id`, new modules — so
history is worth keeping, and a deleted fit should stop showing without losing
what it was.

```
character_fitting_over_time
  id            bigint identity pk
  character_id  uuid → registration(id) on delete cascade
  owner_scope   text not null default 'character'   -- see the ESI note above
  fitting_id    bigint not null
  name          text
  description   text
  ship_type_id  bigint not null
  items         jsonb not null   -- [{ type_id, flag, quantity }]
  is_current    boolean, valid_from timestamptz, valid_until timestamptz
```

- Unique partial index on `(character_id, fitting_id) where is_current` — one
  live row per fit, and the collision guard the reconcile relies on.
- `items` stays jsonb rather than a child table: a fit is a small, opaque blob
  that is always read whole and never joined against, exactly like
  `character_clone_over_time.implants`.
- RLS: `character_id in (select id from registration where user_id = auth.uid())`,
  the same policy every `character_*` table carries. A `character_fitting` view
  (`security_invoker`) exposes the `is_current` snapshot.
- Written to `schema.sql` (the from-scratch reset) **and** a new
  `supabase/migrations/` file, per CLAUDE.md.

### Job

`character-fittings`, one job per ESI endpoint, following the established
shape end to end:

- `src/esi.js` — `fittings(access_token, characterID, ifNoneMatch)`. The
  endpoint returns the whole collection in one un-paginated request and sends
  an ETag, so it qualifies for `esiConditionalJson`: a `304` skips the
  reconcile entirely. Fittings change rarely, so the hit rate should be high.
- `src/jobs/characterFittings.js` — `runCharacterFittings()` over
  `forEachCharacter`, plus the SCD-2 reconcile (signature compare → touch /
  close+open / close vanished) and the `esi_etag` store-after-commit dance the
  orders/transactions/industry-jobs jobs use.
- `src/workflows/characterFittings.ts` — the per-character fan-out workflow
  shape from phase 3 of the cron → Workflows migration (`enumerateCharacters`,
  lanes, `AggregateError`).
- `src/app/api/cron/character-fittings/route.ts` + a `vercel.json` crons entry.
  Every 6h at `:34`, in the gap between `character-mercenary-dens` (`:30`) and
  `corp-wallet-journal` (`:37`).
- Queue consumer entry + `PER_CHARACTER_JOBS` so adding a character pulls
  fittings immediately and the `/character/refresh` matrix gets a row.
- `package.json` script, for the CLI path.

### Deliberately not in PR 2

Type-name resolution of the fitted modules. The page resolves names through
the existing `sde_*` loaders at render time; storing names in the table would
just be a stale copy of the SDE mirror.

## PR 3 — the `/fitting` page

- `/fitting` — every fitting visible to the signed-in user (RLS does the
  scoping), grouped by ship with the hull name and icon, the fit's name and
  description, the owning character, and a module count. Sorted by ship name,
  then fit name. A header nav link next to `blueprint`.
- `/fitting/[characterId]/[fittingId]` — the detail page. `fitting_id` is only
  unique per character (ESI numbers them from 1 per pilot), so the route
  carries the registration uuid too rather than pretending the id is global.
- The detail page renders `ShipFitViewDynamic` — the same `ssr:false` wrapper
  `/ship/[itemId]` uses, which is what keeps the dogma-engine WASM and the
  eveship.fit data payload out of every other route's bundle. Its `esiFit`
  prop is the ESI fitting shape already, so the reshape is a two-line map
  (ESI's fitting items carry no `item_id`; the viewer's `EsiFit` type wants
  one, so the index is used as a synthetic id — it is only an identity key for
  the viewer's slot bookkeeping and never leaves the browser).
- No write path. The viewer is interactive (drag a charge onto a slot to
  simulate ammo) exactly as it is on `/ship/[itemId]`; nothing is ever sent
  back to ESI, which is also why `esi-fittings.write_fittings.v1` is not
  requested.

## Verification

`pnpm run lint` and `pnpm run build` per PR — the codebase's standing check for
the I/O-heavy paths, since the extract jobs aren't unit-tested. The SCD-2
reconcile follows a pattern with several existing implementations to diff
against; the page is a server component reading a view.
