import type { SupabaseClient } from '@supabase/supabase-js'
import { GraphQLError } from 'graphql'

import { GRAPHQL_FLAG, hasFlag } from '@/flags'
import { resolvePlayer } from '@/utils/apiToken'
import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { ASSET_CAP, EXPORT_CAP, LIST_CAP } from './filters'

// The per-request context every resolver receives. Two auth modes share it:
//
// - token: `Authorization: Bearer <api_token>` (the same per-user token the
//   Sheets CSV endpoints use) resolves via the SERVICE-ROLE client, which
//   bypasses RLS — so registrationIds is the only barrier between users.
// - session: the Supabase auth cookie (the in-browser /graphql page), where
//   RLS scopes every read anyway.
//
// THE LEAK GUARD: every resolver must filter .in('registration_id', ...) from
// ctx.registrationIds explicitly, in BOTH modes. In session mode that's
// redundant with RLS (harmless); in token mode it is load-bearing.

// The public identity behind an owner, for the Owner type's corp/alliance
// fields. Everything here comes from world-readable directory tables, never
// from `registration` (which RLS hides from non-owners), so a shared row's
// foreign grantor resolves through exactly the same path as your own character.
export type OwnerIdentity = {
  characterId: string | null
  corporationId: string | null
  corporationName: string | null
  allianceId: string | null
  allianceName: string | null
}

// The public identity behind a corporation that owns rows, for the
// Corporation entity edge. World-readable tables only, exactly like
// OwnerIdentity above.
export type CorporationIdentity = {
  name: string | null
  allianceId: string | null
  allianceName: string | null
}

export type GraphqlContext = {
  supabase: SupabaseClient
  mode: 'session' | 'token'
  userId: string
  registrationIds: string[]
  // registration uuid → character name, for owner filters and ownerName fields.
  ownerNameById: Map<string, string>
  // registration uuid → EVE character id, for Owner.characterId on the caller's
  // own characters (free — it rides along on the context's registration read).
  ownerCharacterIdById: Map<string, string>
  // The corporations the caller's characters belong to. Corp-owned rows
  // (corp_asset, corp_blueprint, corp_industry_job) are RLS-scoped to exactly
  // this set in session mode; in token mode the service client bypasses RLS, so
  // this list IS the leak guard on the corp side — the corp equivalent of
  // registrationIds. Ids are strings for the same reason every id in the schema
  // is: EVE ids overflow 32-bit Int.
  corporationIds: string[]
  // Per-list row bounds the resolvers cap with. The HTTP surfaces get the
  // defaults (ASSET_CAP/LIST_CAP); the lens CSV export raises both to
  // EXPORT_CAP, since a Sheets tab can't page and a silently shortened CSV is
  // worse than a refusal (docs/sharing-layer/09-sheets-parity.md).
  caps: { asset: number; list: number }
  // Lazily load the caller's corporation identities (name, alliance) — only the
  // Corporation edge reads them, and there are a handful at most, so one memo
  // per request covers every result set.
  corporationIdentities: () => Promise<Map<string, CorporationIdentity>>
  // Lazily load the identities for one result set's owners. The Owner type's
  // corp/alliance fields are the only callers, so an unselected edge costs
  // nothing; when they are selected, every row of a result set passes the SAME
  // scope array (the root resolver hands each Owner the same reference), which
  // this memoizes on — so the edge resolves in one pass, never per row.
  ownerIdentities: (scope: readonly string[]) => Promise<Map<string, OwnerIdentity>>
}

const deny = (message: string, status: number): never => {
  throw new GraphQLError(message, { extensions: { http: { status } } })
}

const str = (v: number | string | null | undefined): string | null => (v == null ? null : String(v))

type DirectoryRow = {
  character_id: number | string | null
  corporation_id: number | string | null
  alliance_id: number | string | null
  registration_id: string | null
}

// One pass over the world-readable directory tables for a whole result set's
// owners: character_directory joins registration uuid → EVE identity, then the
// corporation/alliance tables put names on those ids. Three small `in()` reads
// at worst, and only when a query selects an Owner corp/alliance field.
const loadOwnerIdentities = async (
  supabase: SupabaseClient,
  registrationIds: readonly string[]
): Promise<Map<string, OwnerIdentity>> => {
  const ids = [...new Set(registrationIds)]
  if (ids.length === 0) return new Map()

  const { data } = await supabase
    .from('character_directory')
    .select('character_id, corporation_id, alliance_id, registration_id')
    .in('registration_id', ids)
  const rows = ((data ?? []) as DirectoryRow[]).filter((r) => r.registration_id != null)

  const idsOf = (pick: (row: DirectoryRow) => number | string | null): number[] =>
    [...new Set(rows.map(pick).filter((v): v is number | string => v != null))].map(Number)
  const corporationIds = idsOf((r) => r.corporation_id)
  const allianceIds = idsOf((r) => r.alliance_id)

  const [{ data: corporations }, { data: alliances }] = await Promise.all([
    corporationIds.length
      ? supabase.from('corporation').select('corporation_id, name').in('corporation_id', corporationIds)
      : Promise.resolve({ data: [] }),
    allianceIds.length
      ? supabase.from('alliance').select('alliance_id, name').in('alliance_id', allianceIds)
      : Promise.resolve({ data: [] }),
  ])
  const corporationNames = new Map(
    ((corporations ?? []) as Array<{ corporation_id: number | string; name: string | null }>).map((c) => [
      String(c.corporation_id),
      c.name,
    ])
  )
  const allianceNames = new Map(
    ((alliances ?? []) as Array<{ alliance_id: number | string; name: string | null }>).map((a) => [
      String(a.alliance_id),
      a.name,
    ])
  )

  return new Map(
    rows.map((r): [string, OwnerIdentity] => {
      const corporationId = str(r.corporation_id)
      const allianceId = str(r.alliance_id)
      return [
        r.registration_id as string,
        {
          characterId: str(r.character_id),
          corporationId,
          corporationName: corporationId == null ? null : (corporationNames.get(corporationId) ?? null),
          allianceId,
          allianceName: allianceId == null ? null : (allianceNames.get(allianceId) ?? null),
        },
      ]
    })
  )
}

// The caller's corporations, named. `corporation` and `alliance` are both
// world-readable, so this resolves identically in session and token mode.
const loadCorporationIdentities = async (
  supabase: SupabaseClient,
  corporationIds: readonly string[]
): Promise<Map<string, CorporationIdentity>> => {
  if (corporationIds.length === 0) return new Map()
  const { data } = await supabase
    .from('corporation')
    .select('corporation_id, name, alliance_id')
    .in('corporation_id', corporationIds.map(Number))
  const rows = (data ?? []) as Array<{
    corporation_id: number | string
    name: string | null
    alliance_id: number | string | null
  }>

  const allianceIds = [...new Set(rows.map((r) => r.alliance_id).filter((id): id is number | string => id != null))]
  const { data: alliances } = allianceIds.length
    ? await supabase.from('alliance').select('alliance_id, name').in('alliance_id', allianceIds.map(Number))
    : { data: [] }
  const allianceNames = new Map(
    ((alliances ?? []) as Array<{ alliance_id: number | string; name: string | null }>).map((a) => [
      String(a.alliance_id),
      a.name,
    ])
  )

  return new Map(
    rows.map((r): [string, CorporationIdentity] => {
      const allianceId = str(r.alliance_id)
      return [
        String(r.corporation_id),
        {
          name: r.name,
          allianceId,
          allianceName: allianceId == null ? null : (allianceNames.get(allianceId) ?? null),
        },
      ]
    })
  )
}

// The context for a given user on a given client — the tail every entry point
// shares once auth has produced a (client, userId) pair. Owner names come from
// the user's own registration rows, scoped by user_id here rather than through
// fetchOwners, whose unscoped registration select would return every user's
// characters under the service client.
const contextFor = async (
  supabase: SupabaseClient,
  mode: GraphqlContext['mode'],
  userId: string,
  caps: GraphqlContext['caps'] = { asset: ASSET_CAP, list: LIST_CAP }
): Promise<GraphqlContext> => {
  const { data: registrations, error } = await supabase
    .from('registration')
    .select('id, name, character_id, corporation_id')
    .eq('user_id', userId)
  if (error) deny('Lookup failed', 500)

  const rows = (registrations ?? []) as Array<{
    id: string
    name: string
    character_id: number | string | null
    corporation_id: number | string | null
  }>
  const corporationIds = [...new Set(rows.map((r) => str(r.corporation_id)).filter((id): id is string => id != null))]

  // Per-request memo keyed on the scope array's identity, not its contents: a
  // root resolver hands every Owner in its result set the same array, so the
  // first field resolver to look starts the load and the rest await it.
  const identitiesByScope = new WeakMap<readonly string[], Promise<Map<string, OwnerIdentity>>>()
  let corporationIdentities: Promise<Map<string, CorporationIdentity>> | null = null

  return {
    supabase,
    mode,
    userId,
    registrationIds: rows.map((r) => r.id),
    ownerNameById: new Map(rows.map((r) => [r.id, r.name])),
    ownerCharacterIdById: new Map(
      rows.flatMap((r): Array<[string, string]> => (r.character_id == null ? [] : [[r.id, String(r.character_id)]]))
    ),
    corporationIds,
    caps,
    corporationIdentities: () => {
      corporationIdentities ??= loadCorporationIdentities(supabase, corporationIds)
      return corporationIdentities
    },
    ownerIdentities: (scope) => {
      const inFlight = identitiesByScope.get(scope)
      if (inFlight) return inFlight
      const loading = loadOwnerIdentities(supabase, scope)
      identitiesByScope.set(scope, loading)
      return loading
    },
  }
}

// A user's GraphQL context outside any request auth: the service client plus
// their registrations — what api_token mode builds, minus the token lookup.
// This is how a Lens (docs/sharing-layer/07-lens.md) runs a stored query
// under its CREATOR's security context: mode 'token' means the session-only
// surfaces (includeShared/sharedWithMe) reject exactly as they do for Bearer
// callers, and the resolvers' leak-guard .in('registration_id', …) is the
// barrier. Callers must have authorized the viewer BEFORE building this.
// `exporting` is the lens CSV surface's cap raise — see GraphqlContext.caps.
export const contextForUser = (
  userId: string,
  { exporting = false }: { exporting?: boolean } = {}
): Promise<GraphqlContext> =>
  contextFor(createServiceClient(), 'token', userId, exporting ? { asset: EXPORT_CAP, list: EXPORT_CAP } : undefined)

export const buildContext = async (request: Request): Promise<GraphqlContext> => {
  const authorization = request.headers.get('authorization') ?? ''
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''

  let supabase: SupabaseClient
  let mode: GraphqlContext['mode']
  let userId: string

  if (bearer !== '') {
    const player = await resolvePlayer(bearer)
    if (!player.ok) return deny(player.error, player.status)
    supabase = player.supabase
    userId = player.userId
    mode = 'token'
  } else {
    supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user) return deny('Not signed in. Send Authorization: Bearer <api_token>, or sign in.', 401)
    userId = data.user.id
    mode = 'session'
  }

  if (!(await hasFlag(userId, GRAPHQL_FLAG))) {
    deny('The GraphQL API is not enabled for this account.', 403)
  }

  return contextFor(supabase, mode, userId)
}
