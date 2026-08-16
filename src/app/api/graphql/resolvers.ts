// Root resolvers for /api/graphql. Flat by design: each Query field returns
// fully-materialized rows with names resolved here, batched once per result
// set.
//
// The `owner`/`type`/`location` entity edges (see the SDL header for why they
// exist) are built RIGHT HERE, in the root resolver, out of data it already
// had — the SDE type rows and resolved locations it used to mine for a single
// name each. So the edges add no queries and cannot fan out per row. The only
// type-level resolvers are Owner's and Corporation's identity blocks at the
// bottom, which load lazily and once per result set.
//
// THE LEAK GUARD (see context.ts): every table read filters by owner from the
// context — .in('registration_id', …) on the character tables, and
// .in('corporation_id', …) from ctx.corporationIds on the corp ones. In session
// mode that's redundant with RLS; in token mode the client is service-role and
// these filters are the only barrier between users.
import { GraphQLError } from 'graphql'
import { uniq } from 'ramda'

import { guessLocationRef, resolveTypeFilter } from '@/app/api/mcp/lib'
import { resolveLocations, type LocationRef, type ResolvedLocations } from '@/app/resolveLocations'
import { getSdeTypes, searchSdeTypesAll, type SdeType } from '@/sdeTypes'
import { clampLimit, matchExactNames, matchOwnerFilter, parseRefFilter, parseSince, splitRefEntries } from './filters'
import { searchLocationCandidates } from './locationSearch'
import { resolveTargets, restockLines, type Stack } from './restock'
import type { OwnerScopes } from './filters'
import type { GraphqlContext } from './context'

const badRequest = (message: string): never => {
  throw new GraphQLError(message, { extensions: { http: { status: 400 } } })
}

const queryFailed = (): never => {
  throw new GraphQLError('Query failed', { extensions: { http: { status: 500 } } })
}

// The item-type dimension → SDE type ids, or null for no filter. `type` runs
// the fuzzy SDE search (with the MCP layer's "too many matches" guard);
// `types` takes exact type ids and whole type names, mixed. parseRefFilter
// rejects passing both.
const typeIdsFor = async (args: {
  type?: string | null
  types?: readonly string[] | null
}): Promise<number[] | null> => {
  const parsed = parseRefFilter(args.type, args.types, 'type')
  if (!parsed.ok) return badRequest(parsed.message)
  const query = parsed.query
  if (query.kind === 'none') return null
  if (query.kind === 'search') {
    const filter = await resolveTypeFilter(query.term)
    if (!filter.ok) return badRequest(filter.message)
    return filter.matches === null ? null : filter.matches.map((m) => m.typeID)
  }

  // A name in the exact list still goes through the ranked SDE search — it's
  // the only name index there is — but only a WHOLE-name hit counts.
  const { ids, names } = splitRefEntries(query.entries)
  const found = await Promise.all(names.map(async (name) => [name, await searchSdeTypesAll(name)] as const))
  const byName = new Map(
    found.map(([name, matches]) => [name, matches.map((m) => ({ id: String(m.typeID), name: m.name }))])
  )
  const matched = matchExactNames(names, (name) => byName.get(name) ?? [])
  if (matched.unmatched.length > 0) {
    return badRequest(`No item type matched ${matched.unmatched.map((u) => `"${u}"`).join(', ')}.`)
  }
  return [...new Set([...ids, ...matched.ids])].map(Number)
}

// The location dimension → location ids, or null for no filter. `location`
// searches names (station, structure or system — see locationSearch.ts) and
// keeps everything it matched; `locations` takes exact ids and whole names.
const locationIdsFor = async (
  ctx: GraphqlContext,
  args: { location?: string | null; locations?: readonly string[] | null }
): Promise<string[] | null> => {
  const parsed = parseRefFilter(args.location, args.locations, 'location')
  if (!parsed.ok) return badRequest(parsed.message)
  const query = parsed.query
  if (query.kind === 'none') return null
  if (query.kind === 'search') {
    const candidates = await searchLocationCandidates(query.term, ctx.supabase)
    if (candidates.length === 0) return badRequest(`No location matched "${query.term}".`)
    return candidates.map((c) => c.id)
  }

  const { ids, names } = splitRefEntries(query.entries)
  const found = await Promise.all(
    names.map(async (name) => [name, await searchLocationCandidates(name, ctx.supabase)] as const)
  )
  const byName = new Map(found)
  const matched = matchExactNames(names, (name) => byName.get(name) ?? [])
  if (matched.unmatched.length > 0) {
    return badRequest(`No location matched ${matched.unmatched.map((u) => `"${u}"`).join(', ')}.`)
  }
  return [...new Set([...ids, ...matched.ids])]
}

// Page a filtered select up to `cap` rows — PostgREST caps a single request at
// 1000, so larger caps recurse a page at a time (tail-recursive per house style).
const PAGE_SIZE = 1000

const fetchCapped = async <T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  cap: number,
  from = 0,
  acc: T[] = []
): Promise<T[]> => {
  const to = Math.min(from + PAGE_SIZE, cap) - 1
  const { data, error } = await build(from, to)
  if (error) return queryFailed()
  const rows = data ?? []
  acc.push(...rows)
  return acc.length >= cap || rows.length < to - from + 1 ? acc : fetchCapped(build, cap, from + PAGE_SIZE, acc)
}

// Batch-resolve the SDE rows behind a result set's type ids. This used to ask
// for names only; it now keeps the whole row, because getSdeTypes was fetching
// (and per-process caching) group/category/volume all along — the ItemType edge
// is those already-paid-for columns stopped being thrown away.
type SdeTypes = Record<number, SdeType>

const typesFor = async (typeIds: Array<number | string | null | undefined>): Promise<SdeTypes> =>
  getSdeTypes(uniq(typeIds.filter((id): id is number | string => id != null).map(Number)))

const typeNameOf = (types: SdeTypes, typeId: number | string | null | undefined): string | null =>
  typeId == null ? null : (types[Number(typeId)]?.name ?? null)

// Batch-resolve display names for a set of location refs (station, structure,
// solar system, or a container/ship item id that falls back to a raw label).
const locationNamesFor = async (ctx: GraphqlContext, refs: Array<LocationRef | null>): Promise<ResolvedLocations> => {
  const byId = new Map((refs.filter(Boolean) as LocationRef[]).map((r) => [r.id, r]))
  return resolveLocations([...byId.values()], ctx.supabase)
}

const str = (v: number | string | null | undefined): string | null => (v == null ? null : String(v))

// --- The entity edges -------------------------------------------------------
// Three pure reshapes of what the root resolver already holds. Each returns a
// leaf-only object (the SDL invariant that keeps every row CSV-flattenable).

const itemTypeOf = (types: SdeTypes, typeId: number | string | null | undefined) => {
  if (typeId == null) return null
  const t: SdeType | undefined = types[Number(typeId)]
  return {
    typeId: String(typeId),
    name: t?.name ?? null,
    groupId: str(t?.groupID),
    groupName: t?.groupName ?? null,
    categoryId: str(t?.categoryID),
    categoryName: t?.categoryName ?? null,
    metaGroupId: str(t?.metaGroupID),
    volume: t?.volume ?? null,
  }
}

const locationOf = (locations: ResolvedLocations, ref: LocationRef | null) => {
  if (ref === null) return null
  const systemId = locations.systemIdFor(ref)
  return {
    locationId: ref.id,
    name: locations.nameFor(ref),
    systemId: str(systemId),
    systemName: locations.systemFor(ref) ?? null,
  }
}

// The Character edge. `scope` is the result set's full registration id list,
// carried on every Character of that set BY REFERENCE — it's what the context
// memoizes the corp/alliance load on, so the whole set resolves in one pass. It
// isn't in the SDL, so it's invisible to callers.
type CharacterRef = { id: string; name: string; scope: readonly string[] }

// The Corporation edge, for rows a CORPORATION owns rather than a character.
// Only the id comes from the row; name and alliance load lazily and once per
// request off the context memo.
type CorporationRef = { corporationId: string }

// corporation id → name, off the context's per-request memo. Used both to
// match the owner filter and to fill the corporation columns on corp rows.
const corporationNamesFor = async (ctx: GraphqlContext): Promise<Map<string, string>> => {
  const identities = await ctx.corporationIdentities()
  return new Map(
    [...identities].flatMap(([id, identity]): Array<[string, string]> =>
      identity.name == null ? [] : [[id, identity.name]]
    )
  )
}

// Who owns a row. Corp-owned rows have no registration behind them, so the
// two sides are a discriminated union rather than a nullable column.
type OwnedBy = { kind: 'character'; registrationId: string } | { kind: 'corporation'; corporationId: string }

// The name and EVE id behind a registration, for the character columns.
export type CharacterIdentity = { name: string; characterId: string | null }

// The caller's own characters as identities — no query, it's all on the
// context already. Rows that can only be owned by the caller's characters
// (everything but a shared asset) resolve their owner block from this.
const ownCharacters = (ctx: GraphqlContext): ReadonlyMap<string, CharacterIdentity> =>
  new Map(
    [...ctx.ownerNameById].map(([id, name]): [string, CharacterIdentity] => [
      id,
      { name, characterId: ctx.ownerCharacterIdById.get(id) ?? null },
    ])
  )

// THE OWNER BLOCK every row type carries. The character and corporation columns
// are each filled only on their own side, and the owner columns are the
// COALESCE of the two — so `ownerName` always has a value while
// `characterName`/`corporationName` say which kind it is, and `ownerType`
// states it outright. The two typed edges follow the same split.
//
// `characterId` is the EVE character id, not the registration uuid, so
// `ownerId` is an EVE id whichever side a row came from; the registration uuid
// is still reachable as `character { id }`. It falls back to the uuid only if
// a registration somehow has no character id recorded.
const ownerFieldsOf = (
  owned: OwnedBy,
  characters: ReadonlyMap<string, CharacterIdentity>,
  corporationNames: ReadonlyMap<string, string>,
  ownerScope: readonly string[]
) => {
  if (owned.kind === 'corporation') {
    const name = corporationNames.get(owned.corporationId) ?? owned.corporationId
    return {
      ownerType: 'corporation',
      ownerId: owned.corporationId,
      ownerName: name,
      characterId: null,
      characterName: null,
      corporationId: owned.corporationId,
      corporationName: name,
      character: null,
      corporation: { corporationId: owned.corporationId } as CorporationRef,
    }
  }
  const identity = characters.get(owned.registrationId)
  const characterId = identity?.characterId ?? owned.registrationId
  const characterName = identity?.name ?? owned.registrationId
  return {
    ownerType: 'character',
    ownerId: characterId,
    ownerName: characterName,
    characterId,
    characterName,
    corporationId: null,
    corporationName: null,
    character: { id: owned.registrationId, name: characterName, scope: ownerScope } as CharacterRef,
    corporation: null,
  }
}

// The two owner scopes a field reads, after the owner filter. One filter spans
// both kinds of owner (filters.ts), so naming a character narrows to that
// character and drops the corp hangar, naming a corporation does the reverse,
// naming both unions them, and naming neither reads everything the caller owns.
const ownerScopesFor = async (
  ctx: GraphqlContext,
  args: { owner?: string | null; owners?: readonly string[] | null }
): Promise<OwnerScopes> => {
  const filtered = args.owner != null || args.owners != null
  const match = matchOwnerFilter(args.owner, args.owners, {
    characters: { nameById: ctx.ownerNameById, characterIdById: ctx.ownerCharacterIdById },
    // Only a filter needs corporation names, so the load stays behind one.
    corporations: filtered ? await corporationNamesFor(ctx) : new Map(),
  })
  if (!match.ok) badRequest(match.message)
  const scopes = match.ok ? match.scopes : null
  return scopes ?? { registrationIds: ctx.registrationIds, corporationIds: ctx.corporationIds }
}

// The character side alone, for the fields with no corp-owned source behind
// them (market orders and wallet transactions — ESI's corporation endpoints for
// those aren't extracted). An owner filter naming ONLY corporations can't be
// honoured there, and saying so beats returning zero rows as if none existed.
const characterScopeFor = async (
  ctx: GraphqlContext,
  args: { owner?: string | null; owners?: readonly string[] | null },
  what: string
): Promise<string[]> => {
  const scopes = await ownerScopesFor(ctx, args)
  if (scopes.registrationIds.length === 0 && scopes.corporationIds.length > 0) {
    badRequest(`${what} are extracted per character only, so a corporation-only owner filter matches nothing here.`)
  }
  return scopes.registrationIds
}

// Session-only guard for the shared-data surfaces: the Bearer path runs on the
// service client, where RLS can't arbitrate a widened filter — the designed
// answer for external tools consuming shared data is a Lens (phase 7).
const requireSession = (ctx: GraphqlContext): void => {
  if (ctx.mode !== 'session') {
    badRequest('Shared data requires a session — the api_token path is own-data only. Use a Lens instead.')
  }
}

// The grantor registration ids behind share rows the caller's audience
// matches — what RLS exposes on character_asset_share beyond the caller's own
// rows. RLS is the authority; this list just widens the resolvers' explicit
// .in() so shared rows aren't filtered back out by the leak guard.
const grantorRegistrationIds = async (ctx: GraphqlContext): Promise<string[]> => {
  const { data, error } = await ctx.supabase.from('character_asset_share').select('registration_id')
  if (error) return queryFailed()
  const own = new Set(ctx.registrationIds)
  return [...new Set(((data ?? []) as Array<{ registration_id: string }>).map((r) => r.registration_id))].filter(
    (id) => !own.has(id)
  )
}

// Name and EVE character id for a mixed set of registration ids: the caller's
// own from the context, foreign grantors through the world-readable
// character_directory (never registration, which RLS hides to non-owners).
const characterIdentitiesFor = async (
  ctx: GraphqlContext,
  registrationIds: Iterable<string>
): Promise<Map<string, CharacterIdentity>> => {
  const identities = new Map(
    [...ctx.ownerNameById].map(([id, name]): [string, CharacterIdentity] => [
      id,
      { name, characterId: ctx.ownerCharacterIdById.get(id) ?? null },
    ])
  )
  const foreign = [...new Set([...registrationIds])].filter((id) => !identities.has(id))
  if (foreign.length > 0) {
    const { data } = await ctx.supabase
      .from('character_directory')
      .select('registration_id, name, character_id')
      .in('registration_id', foreign)
    const rows = (data ?? []) as Array<{
      registration_id: string | null
      name: string | null
      character_id: number | string | null
    }>
    for (const row of rows) {
      if (row.registration_id != null && row.name != null) {
        identities.set(row.registration_id, { name: row.name, characterId: str(row.character_id) })
      }
    }
  }
  return identities
}

// One shape for both asset sources: character_asset keys on registration_id and
// carries a player-assigned name, corp_asset keys on corporation_id and has
// neither — the columns each source lacks simply arrive undefined.
type AssetRow = {
  item_id: number
  registration_id: string
  corporation_id?: number | string
  type_id: number
  location_id: number | null
  location_flag: string | null
  location_type: string | null
  quantity: number | null
  is_singleton: boolean | null
  is_blueprint_copy: boolean | null
  name?: string | null
}

const assetLocationRef = (row: AssetRow): LocationRef | null =>
  row.location_id == null
    ? null
    : {
        id: String(row.location_id),
        type: row.location_type === 'station' || row.location_type === 'solar_system' ? row.location_type : null,
      }

export const resolvers = {
  Query: {
    characters: (_parent: unknown, _args: unknown, ctx: GraphqlContext) => {
      const scope = ctx.registrationIds
      return [...ctx.ownerNameById]
        .map(([id, name]) => ({ id, name, scope }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    corporations: async (_parent: unknown, _args: unknown, ctx: GraphqlContext) => {
      const names = await corporationNamesFor(ctx)
      return ctx.corporationIds
        .map((corporationId) => ({ corporationId, name: names.get(corporationId) ?? corporationId }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    assets: async (
      _parent: unknown,
      args: {
        type?: string | null
        types?: readonly string[] | null
        location?: string | null
        locations?: readonly string[] | null
        owner?: string | null
        owners?: readonly string[] | null
        limit?: number | null
        includeShared?: boolean | null
      },
      ctx: GraphqlContext
    ) => {
      // includeShared widens the leak-guard filter to own ∪ grantor
      // registrations and lets RLS decide which grantor rows come back — the
      // DB is the authority; the widened .in() is just no longer the barrier.
      // The character filter still narrows only the caller's own characters;
      // shared rows ride along unfiltered.
      if (args.includeShared) requireSession(ctx)
      const scopes = await ownerScopesFor(ctx, args)
      // Shared rows ride the character side, so a corporation-only filter (which
      // empties that side) excludes them along with your own character rows.
      const sharedIds = args.includeShared && scopes.registrationIds.length > 0 ? await grantorRegistrationIds(ctx) : []
      const scopedIds = [...scopes.registrationIds, ...sharedIds]
      const typeIds = await typeIdsFor(args)
      const locationIds = await locationIdsFor(ctx, args)
      const cap = clampLimit(args.limit, ctx.caps.asset)

      // The same filter set applies to the head-only count and the row pages,
      // on both sides — only the owner column differs. The builder is untyped
      // (no generated DB types in this repo), so `any`.
      const filtered = (query: any, ownerColumn: string, ownerIds: string[]): any => {
        let q = query.in(ownerColumn, ownerIds)
        if (typeIds !== null) q = q.in('type_id', typeIds)
        if (locationIds !== null) q = q.in('location_id', locationIds)
        return q
      }

      // One source per owner side, each skipped entirely when the filters
      // excluded it. character_asset carries a player-assigned `name`;
      // corp_asset has no such column, so those rows report null.
      const read = async (
        table: string,
        ownerColumn: string,
        ownerIds: string[]
      ): Promise<{ count: number; rows: AssetRow[] }> => {
        if (ownerIds.length === 0) return { count: 0, rows: [] }
        const { count, error } = await filtered(
          ctx.supabase.from(table).select('item_id', { count: 'exact', head: true }),
          ownerColumn,
          ownerIds
        )
        if (error) return queryFailed()
        const rows = await fetchCapped<AssetRow>(
          (from, to) =>
            filtered(ctx.supabase.from(table).select('*'), ownerColumn, ownerIds).order('item_id').range(from, to),
          cap
        )
        return { count: count ?? 0, rows }
      }

      const [own, corp] = await Promise.all([
        read('character_asset', 'registration_id', scopedIds),
        read('corp_asset', 'corporation_id', scopes.corporationIds),
      ])
      const totalCount = own.count + corp.count
      // The cap bounds the MERGED set, so a caller asking for 50 rows across
      // both sides gets 50 rows, not 50 of each.
      const rows = [
        ...own.rows.map((r) => ({ row: r, owned: { kind: 'character' as const, registrationId: r.registration_id } })),
        ...corp.rows.map((r) => ({
          row: r,
          owned: { kind: 'corporation' as const, corporationId: String(r.corporation_id) },
        })),
      ].slice(0, cap)

      const [types, locations, characters, corporationNames] = await Promise.all([
        typesFor(rows.map(({ row }) => row.type_id)),
        locationNamesFor(
          ctx,
          rows.map(({ row }) => assetLocationRef(row))
        ),
        characterIdentitiesFor(
          ctx,
          own.rows.map((r) => r.registration_id)
        ),
        corp.rows.length > 0 ? corporationNamesFor(ctx) : Promise.resolve(new Map<string, string>()),
      ])
      const ownerScope = uniq(own.rows.map((r) => r.registration_id))

      return {
        totalCount,
        truncated: totalCount > rows.length,
        rows: rows.map(({ row: r, owned }) => {
          const ref = assetLocationRef(r)
          return {
            itemId: String(r.item_id),
            typeId: String(r.type_id),
            typeName: typeNameOf(types, r.type_id),
            quantity: String(r.quantity ?? 1),
            locationId: str(r.location_id),
            locationFlag: r.location_flag,
            locationType: r.location_type,
            locationName: ref ? locations.nameFor(ref) : null,
            isSingleton: r.is_singleton,
            isBlueprintCopy: r.is_blueprint_copy,
            name: r.name ?? null,
            ...ownerFieldsOf(owned, characters, corporationNames, ownerScope),
            type: itemTypeOf(types, r.type_id),
            location: locationOf(locations, ref),
          }
        }),
      }
    },

    restock: async (
      _parent: unknown,
      args: {
        targets: ReadonlyArray<{ type: string; quantity: number }>
        location?: string | null
        locations?: readonly string[] | null
        owner?: string | null
        owners?: readonly string[] | null
        onlyBelowTarget?: boolean | null
      },
      ctx: GraphqlContext
    ) => {
      // Target names resolve the way an exact `types:` list does — through the
      // ranked SDE search, counting only whole-name hits (see typeIdsFor).
      const names = uniq(args.targets.map((t) => (t.type ?? '').trim()).filter((t) => t !== '' && !/^\d+$/.test(t)))
      const found = await Promise.all(names.map(async (name) => [name, await searchSdeTypesAll(name)] as const))
      const byName = new Map(
        found.map(([name, matches]) => [name, matches.map((m) => ({ id: String(m.typeID), name: m.name }))])
      )
      const resolved = resolveTargets(args.targets, (name) => byName.get(name) ?? [])
      if (!resolved.ok) return badRequest(resolved.message)
      const targetTypeIds = resolved.targets.map((t) => t.typeId)

      // One SDE batch covers three needs: the line names, the ItemType edge,
      // and existence-checking the targets given as bare ids — an id the SDE
      // doesn't know is an error, not a phantom line reading zero on hand.
      const types = await typesFor(targetTypeIds)
      const unknown = targetTypeIds.filter((id) => types[id] === undefined)
      if (unknown.length > 0) {
        return badRequest(`No item type matched ${unknown.map((id) => `"${id}"`).join(', ')}.`)
      }

      const scopes = await ownerScopesFor(ctx, args)
      const locationIds = await locationIdsFor(ctx, args)

      // A TARGETED read: only the target types, only the two columns the sum
      // needs. Filtering by type keeps this far below the cap that paging the
      // whole hangar would hit — and a truncated read here wouldn't look
      // truncated, it would look like a smaller stockpile.
      const filtered = (query: any, ownerColumn: string, ownerIds: string[]): any => {
        let q = query.in(ownerColumn, ownerIds).in('type_id', targetTypeIds)
        if (locationIds !== null) q = q.in('location_id', locationIds)
        return q
      }

      const read = async (table: string, ownerColumn: string, ownerIds: string[]): Promise<Stack[]> => {
        if (ownerIds.length === 0) return []
        const { count, error } = await filtered(
          ctx.supabase.from(table).select('item_id', { count: 'exact', head: true }),
          ownerColumn,
          ownerIds
        )
        if (error) return queryFailed()
        // Refuse rather than sum a truncated read: a wrong total here is a
        // wrong number to buy, and nothing downstream could tell.
        if ((count ?? 0) > ctx.caps.asset) {
          return badRequest(
            `Too many stacks to sum reliably (${count} in ${table}) — narrow the owner or location filter.`
          )
        }
        return fetchCapped<Stack>(
          (from, to) =>
            filtered(ctx.supabase.from(table).select('type_id, quantity'), ownerColumn, ownerIds)
              .order('item_id')
              .range(from, to),
          ctx.caps.asset
        )
      }

      const [own, corp] = await Promise.all([
        read('character_asset', 'registration_id', scopes.registrationIds),
        read('corp_asset', 'corporation_id', scopes.corporationIds),
      ])

      return restockLines(resolved.targets, [...own, ...corp], args.onlyBelowTarget !== false).map((line) => ({
        typeId: String(line.typeId),
        typeName: typeNameOf(types, line.typeId),
        groupName: types[line.typeId]?.groupName ?? null,
        target: String(line.target),
        onHand: String(line.onHand),
        delta: String(line.delta),
        toBuy: String(line.toBuy),
        type: itemTypeOf(types, line.typeId),
      }))
    },

    sharedWithMe: async (_parent: unknown, _args: unknown, ctx: GraphqlContext) => {
      requireSession(ctx)

      // Everything RLS exposes on the share table minus the caller's own rows:
      // exactly the shares whose audience they match (link-only shares match
      // no one under RLS, so they never appear here).
      const { data, error } = await ctx.supabase
        .from('character_asset_share')
        .select('id, registration_id, item_id, created_at')
      if (error) return queryFailed()
      const own = new Set(ctx.registrationIds)
      const grants = (
        (data ?? []) as Array<{ id: string; registration_id: string; item_id: number | string; created_at: string }>
      ).filter((g) => !own.has(g.registration_id))
      if (grants.length === 0) return []

      // The shared roots are RLS-visible to the audience (phase 2), so their
      // types resolve through a plain read.
      const { data: items } = await ctx.supabase
        .from('character_asset')
        .select('item_id, type_id')
        .in(
          'item_id',
          grants.map((g) => g.item_id)
        )
      const typeByItem = new Map(
        ((items ?? []) as Array<{ item_id: number | string; type_id: number | string }>).map((i) => [
          String(i.item_id),
          Number(i.type_id),
        ])
      )
      const [types, characters] = await Promise.all([
        typesFor([...typeByItem.values()]),
        characterIdentitiesFor(
          ctx,
          grants.map((g) => g.registration_id)
        ),
      ])
      const ownerScope = uniq(grants.map((g) => g.registration_id))

      return grants.map((g) => {
        const typeId = typeByItem.get(String(g.item_id))
        return {
          shareId: g.id,
          itemId: String(g.item_id),
          itemTypeName: typeNameOf(types, typeId),
          sharedAt: g.created_at,
          ...ownerFieldsOf({ kind: 'character', registrationId: g.registration_id }, characters, new Map(), ownerScope),
          itemType: itemTypeOf(types, typeId),
        }
      })
    },

    blueprints: async (
      _parent: unknown,
      args: {
        type?: string | null
        types?: readonly string[] | null
        owner?: string | null
        owners?: readonly string[] | null
        limit?: number | null
      },
      ctx: GraphqlContext
    ) => {
      const scopes = await ownerScopesFor(ctx, args)
      const typeIds = await typeIdsFor(args)
      const cap = clampLimit(args.limit, ctx.caps.list)

      type BlueprintRow = {
        item_id: number
        registration_id: string
        corporation_id?: number | string
        type_id: number
        location_id: number | null
        location_flag: string | null
        quantity: number | null
        material_efficiency: number | null
        time_efficiency: number | null
        runs: number | null
      }

      const filtered = (query: any, ownerColumn: string, ownerIds: string[]): any => {
        const q = query.in(ownerColumn, ownerIds)
        return typeIds !== null ? q.in('type_id', typeIds) : q
      }

      const read = async (
        table: string,
        ownerColumn: string,
        ownerIds: string[]
      ): Promise<{ count: number; rows: BlueprintRow[] }> => {
        if (ownerIds.length === 0) return { count: 0, rows: [] }
        const { count, error } = await filtered(
          ctx.supabase.from(table).select('item_id', { count: 'exact', head: true }),
          ownerColumn,
          ownerIds
        )
        if (error) return queryFailed()
        const rows = await fetchCapped<BlueprintRow>(
          (from, to) =>
            filtered(ctx.supabase.from(table).select('*'), ownerColumn, ownerIds).order('item_id').range(from, to),
          cap
        )
        return { count: count ?? 0, rows }
      }

      const [own, corp] = await Promise.all([
        read('character_blueprint', 'registration_id', scopes.registrationIds),
        read('corp_blueprint', 'corporation_id', scopes.corporationIds),
      ])
      const totalCount = own.count + corp.count
      const rows = [
        ...own.rows.map((r) => ({ row: r, owned: { kind: 'character' as const, registrationId: r.registration_id } })),
        ...corp.rows.map((r) => ({
          row: r,
          owned: { kind: 'corporation' as const, corporationId: String(r.corporation_id) },
        })),
      ].slice(0, cap)

      const [types, locations, corporationNames] = await Promise.all([
        typesFor(rows.map(({ row }) => row.type_id)),
        locationNamesFor(
          ctx,
          rows.map(({ row }) => guessLocationRef(row.location_id))
        ),
        corp.rows.length > 0 ? corporationNamesFor(ctx) : Promise.resolve(new Map<string, string>()),
      ])

      return {
        totalCount,
        truncated: totalCount > rows.length,
        rows: rows.map(({ row: r, owned }) => {
          const ref = guessLocationRef(r.location_id)
          return {
            itemId: String(r.item_id),
            typeId: String(r.type_id),
            typeName: typeNameOf(types, r.type_id),
            quantity: String(r.quantity ?? 1),
            locationId: str(r.location_id),
            locationFlag: r.location_flag,
            locationName: ref ? locations.nameFor(ref) : null,
            materialEfficiency: r.material_efficiency,
            timeEfficiency: r.time_efficiency,
            runs: r.runs,
            ...ownerFieldsOf(owned, ownCharacters(ctx), corporationNames, scopes.registrationIds),
            type: itemTypeOf(types, r.type_id),
            location: locationOf(locations, ref),
          }
        }),
      }
    },

    marketOrders: async (
      _parent: unknown,
      args: { owner?: string | null; owners?: readonly string[] | null },
      ctx: GraphqlContext
    ) => {
      const ownerIds = await characterScopeFor(ctx, args, 'Market orders')

      type OrderRow = {
        order_id: number
        registration_id: string
        type_id: number
        region_id: number
        location_id: number
        range: string
        is_buy: boolean
        price: number
        volume_total: number
        volume_remain: number
        min_volume: number | null
        escrow: number | null
        duration: number
        issued: string
      }

      const rows = await fetchCapped<OrderRow>(
        (from, to) =>
          ctx.supabase
            .from('character_order')
            .select('*')
            .in('registration_id', ownerIds)
            .order('issued', { ascending: false })
            .range(from, to),
        ctx.caps.list
      )

      const [types, locations] = await Promise.all([
        typesFor(rows.map((r) => r.type_id)),
        locationNamesFor(
          ctx,
          rows.map((r) => guessLocationRef(r.location_id))
        ),
      ])

      return rows.map((r) => {
        const ref = guessLocationRef(r.location_id)
        return {
          orderId: String(r.order_id),
          typeId: String(r.type_id),
          typeName: typeNameOf(types, r.type_id),
          locationId: String(r.location_id),
          locationName: ref ? locations.nameFor(ref) : null,
          regionId: String(r.region_id),
          type: itemTypeOf(types, r.type_id),
          location: locationOf(locations, ref),
          isBuy: r.is_buy,
          price: Number(r.price),
          volumeTotal: String(r.volume_total),
          volumeRemain: String(r.volume_remain),
          minVolume: str(r.min_volume),
          escrow: r.escrow == null ? null : Number(r.escrow),
          range: r.range,
          duration: r.duration,
          issued: r.issued,
          ownerId: r.registration_id,
          ownerName: ctx.ownerNameById.get(r.registration_id) ?? r.registration_id,
        }
      })
    },

    industryJobs: async (
      _parent: unknown,
      args: {
        owner?: string | null
        owners?: readonly string[] | null
        includeDelivered?: boolean | null
      },
      ctx: GraphqlContext
    ) => {
      const scopes = await ownerScopesFor(ctx, args)

      type JobRow = {
        job_id: number
        registration_id: string
        corporation_id?: number | string
        installer_id?: number | string
        activity_id: number
        blueprint_id: number
        blueprint_type_id: number
        blueprint_location_id: number
        output_location_id: number
        product_type_id: number | null
        runs: number
        licensed_runs: number | null
        probability: number | null
        successful_runs: number | null
        status: string
        cost: number | null
        duration: number
        start_date: string
        end_date: string
        pause_date: string | null
        completed_date: string | null
        completed_character_id: number | null
        station_id: number | null
        facility_id: number
      }

      const read = async (table: string, ownerColumn: string, ownerIds: string[]): Promise<JobRow[]> => {
        if (ownerIds.length === 0) return []
        return fetchCapped<JobRow>((from, to) => {
          const q = ctx.supabase
            .from(table)
            .select('*')
            .in(ownerColumn, ownerIds)
            .order('start_date', { ascending: false })
            .range(from, to)
          return args.includeDelivered ? q : q.neq('status', 'delivered')
        }, ctx.caps.list)
      }

      const [own, corp] = await Promise.all([
        read('character_industry_job', 'registration_id', scopes.registrationIds),
        read('corp_industry_job', 'corporation_id', scopes.corporationIds),
      ])
      // Newest first across BOTH sides, then capped — each side came back
      // sorted, so the merged list only needs one sort before the cap.
      const rows = [
        ...own.map((r) => ({ row: r, owned: { kind: 'character' as const, registrationId: r.registration_id } })),
        ...corp.map((r) => ({
          row: r,
          owned: { kind: 'corporation' as const, corporationId: String(r.corporation_id) },
        })),
      ]
        .sort((a, b) => b.row.start_date.localeCompare(a.row.start_date))
        .slice(0, ctx.caps.list)

      const jobLocationRef = (r: JobRow): LocationRef | null => guessLocationRef(r.station_id ?? r.facility_id)

      const [types, locations, corporationNames] = await Promise.all([
        typesFor(rows.flatMap(({ row }) => [row.blueprint_type_id, row.product_type_id])),
        locationNamesFor(
          ctx,
          rows.map(({ row }) => jobLocationRef(row))
        ),
        corp.length > 0 ? corporationNamesFor(ctx) : Promise.resolve(new Map<string, string>()),
      ])

      return rows.map(({ row: r, owned }) => {
        const ref = jobLocationRef(r)
        return {
          jobId: String(r.job_id),
          activityId: r.activity_id,
          blueprintTypeId: String(r.blueprint_type_id),
          blueprintTypeName: typeNameOf(types, r.blueprint_type_id),
          productTypeId: str(r.product_type_id),
          productTypeName: typeNameOf(types, r.product_type_id),
          ...ownerFieldsOf(owned, ownCharacters(ctx), corporationNames, scopes.registrationIds),
          blueprintType: itemTypeOf(types, r.blueprint_type_id),
          productType: itemTypeOf(types, r.product_type_id),
          location: locationOf(locations, ref),
          runs: r.runs,
          licensedRuns: r.licensed_runs,
          probability: r.probability,
          successfulRuns: r.successful_runs,
          status: r.status,
          cost: r.cost == null ? null : Number(r.cost),
          duration: r.duration,
          startDate: r.start_date,
          endDate: r.end_date,
          pauseDate: r.pause_date,
          completedDate: r.completed_date,
          completedCharacterId: str(r.completed_character_id),
          stationId: str(r.station_id),
          blueprintId: String(r.blueprint_id),
          blueprintLocationId: String(r.blueprint_location_id),
          outputLocationId: String(r.output_location_id),
          facilityId: String(r.facility_id),
          locationName: ref ? locations.nameFor(ref) : null,
          // Corp jobs name the character who installed them; character jobs
          // are always installed by their owner, so ESI doesn't repeat it.
          installerId: str(r.installer_id ?? null),
        }
      })
    },

    walletBalances: async (_parent: unknown, _args: unknown, ctx: GraphqlContext) => {
      // character_wallet is an append-only balance history; one small query per
      // registration (a user links a handful of characters) grabs each latest row.
      const latest = await Promise.all(
        ctx.registrationIds.map(async (registrationId) => {
          const { data, error } = await ctx.supabase
            .from('character_wallet')
            .select('registration_id, balance, recorded_at')
            .eq('registration_id', registrationId)
            .order('recorded_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (error) return queryFailed()
          return data as { registration_id: string; balance: number; recorded_at: string } | null
        })
      )

      return latest
        .filter((r): r is NonNullable<typeof r> => r != null)
        .map((r) => ({
          balance: Number(r.balance),
          recordedAt: r.recorded_at,
          ...ownerFieldsOf(
            { kind: 'character', registrationId: r.registration_id },
            ownCharacters(ctx),
            new Map(),
            ctx.registrationIds
          ),
        }))
        .sort((a, b) => a.ownerName.localeCompare(b.ownerName))
    },

    walletTransactions: async (
      _parent: unknown,
      args: {
        type?: string | null
        types?: readonly string[] | null
        owner?: string | null
        owners?: readonly string[] | null
        since?: string | null
        limit?: number | null
      },
      ctx: GraphqlContext
    ) => {
      const ownerIds = await characterScopeFor(ctx, args, 'Wallet transactions')
      const typeIds = await typeIdsFor(args)
      const since = parseSince(args.since)
      if (!since.ok) return badRequest(since.message)
      const cap = clampLimit(args.limit, ctx.caps.list)

      type TransactionRow = {
        transaction_id: number
        registration_id: string
        date: string
        type_id: number
        quantity: number
        unit_price: number
        is_buy: boolean
        location_id: number
      }

      const rows = await fetchCapped<TransactionRow>((from, to) => {
        let q = ctx.supabase
          .from('character_wallet_transaction')
          .select('*')
          .in('registration_id', ownerIds)
          .order('date', { ascending: false })
          .range(from, to)
        if (typeIds !== null) q = q.in('type_id', typeIds)
        if (since.iso !== null) q = q.gte('date', since.iso)
        return q
      }, cap)

      const [types, locations] = await Promise.all([
        typesFor(rows.map((r) => r.type_id)),
        locationNamesFor(
          ctx,
          rows.map((r) => guessLocationRef(r.location_id))
        ),
      ])

      return rows.map((r) => {
        const ref = guessLocationRef(r.location_id)
        return {
          transactionId: String(r.transaction_id),
          date: r.date,
          typeId: String(r.type_id),
          typeName: typeNameOf(types, r.type_id),
          quantity: String(r.quantity),
          unitPrice: Number(r.unit_price),
          isBuy: r.is_buy,
          locationId: String(r.location_id),
          locationName: ref ? locations.nameFor(ref) : null,
          ...ownerFieldsOf(
            { kind: 'character', registrationId: r.registration_id },
            ownCharacters(ctx),
            new Map(),
            ownerIds
          ),
          type: itemTypeOf(types, r.type_id),
          location: locationOf(locations, ref),
        }
      })
    },
  },

  // The Corporation edge's fields, lazy for the same reason Owner's are: a row
  // hands over only the id, and the identities load once per request off the
  // context memo — the caller has a handful of corporations at most.
  Corporation: {
    name: (parent: CorporationRef, _args: unknown, ctx: GraphqlContext) =>
      ctx.corporationIdentities().then((m) => m.get(parent.corporationId)?.name ?? null),
    allianceId: (parent: CorporationRef, _args: unknown, ctx: GraphqlContext) =>
      ctx.corporationIdentities().then((m) => m.get(parent.corporationId)?.allianceId ?? null),
    allianceName: (parent: CorporationRef, _args: unknown, ctx: GraphqlContext) =>
      ctx.corporationIdentities().then((m) => m.get(parent.corporationId)?.allianceName ?? null),
  },

  // The only type-level resolvers in the schema. id/name came with the parent;
  // these four read, so they stay lazy — a query that doesn't ask for a corp or
  // alliance issues no query at all, and one that does resolves the whole result
  // set at once off the memoized scope (context.ts).
  Character: {
    characterId: (parent: CharacterRef, _args: unknown, ctx: GraphqlContext) =>
      ctx.ownerCharacterIdById.get(parent.id) ??
      ctx.ownerIdentities(parent.scope).then((m) => m.get(parent.id)?.characterId ?? null),
    corporationId: (parent: CharacterRef, _args: unknown, ctx: GraphqlContext) =>
      ctx.ownerIdentities(parent.scope).then((m) => m.get(parent.id)?.corporationId ?? null),
    corporationName: (parent: CharacterRef, _args: unknown, ctx: GraphqlContext) =>
      ctx.ownerIdentities(parent.scope).then((m) => m.get(parent.id)?.corporationName ?? null),
    allianceId: (parent: CharacterRef, _args: unknown, ctx: GraphqlContext) =>
      ctx.ownerIdentities(parent.scope).then((m) => m.get(parent.id)?.allianceId ?? null),
    allianceName: (parent: CharacterRef, _args: unknown, ctx: GraphqlContext) =>
      ctx.ownerIdentities(parent.scope).then((m) => m.get(parent.id)?.allianceName ?? null),
  },
}
