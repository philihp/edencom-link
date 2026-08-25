// "Does anyone who shares a library with me have one of these?"
//
// The search on /blueprint, over the libraries somebody else published to us —
// never our own, which the showcase above it already opens. Reads through the
// service role, like /bpos does: the caller's access was settled by
// resolveLibraries() asking corp_bpo_share and bpo_share AS the viewer, so RLS
// has already had its say and the reads below are explicitly scoped to exactly
// the libraries it returned.
import { chain, groupBy, map, splitEvery, uniq } from 'ramda'

import { searchSdeTypesAll } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

import type { BlueprintRow } from '../bpos/stack'
import { resolveLibraries, type Library } from './libraries'
import {
  blueprintMatches,
  foldHits,
  MIN_QUERY_LENGTH,
  type SharedSearchHit,
  type SharedSearchResult,
} from './searchHits'

// PostgREST takes the type-id filter in the URL, so the list is chunked rather
// than sent whole — `sde_search_type` caps at 1000 ids, which would overrun it.
const CHUNK = 200

const BLUEPRINT_COLUMNS = 'type_id, material_efficiency, time_efficiency, quantity, runs'

const empty = (query: string): SharedSearchResult => ({ query, libraries: 0, results: [] })

// Every original of the given types in one corporation's hangars. Chunked, and
// the chunks run together — each is an independent read of an indexed column.
const readCorp = async (corporationId: number, typeIds: number[]): Promise<BlueprintRow[]> => {
  const pages = await Promise.all(
    map(
      async (ids: number[]) => {
        const { data, error } = await createServiceClient()
          .from('corp_blueprint')
          .select(BLUEPRINT_COLUMNS)
          .eq('corporation_id', corporationId)
          .eq('runs', -1)
          .in('type_id', ids)
          .returns<BlueprintRow[]>()
        if (error) {
          console.error(`[blueprint] shared corp search failed: ${error.message}`)
          return []
        }
        return data ?? []
      },
      splitEvery(CHUNK, typeIds)
    )
  )
  return chain((rows: BlueprintRow[]) => rows, pages)
}

// The same, pooled across every character on an account.
const readAccount = async (registrationIds: string[], typeIds: number[]): Promise<BlueprintRow[]> => {
  if (registrationIds.length === 0) return []
  const pages = await Promise.all(
    map(
      async (ids: number[]) => {
        const { data, error } = await createServiceClient()
          .from('character_blueprint')
          .select(BLUEPRINT_COLUMNS)
          .in('registration_id', registrationIds)
          .eq('runs', -1)
          .in('type_id', ids)
          .returns<BlueprintRow[]>()
        if (error) {
          console.error(`[blueprint] shared account search failed: ${error.message}`)
          return []
        }
        return data ?? []
      },
      splitEvery(CHUNK, typeIds)
    )
  )
  return chain((rows: BlueprintRow[]) => rows, pages)
}

// user_id → its registrations, for every account library in one read.
const registrationsByUser = async (userIds: string[]): Promise<Map<string, string[]>> => {
  if (userIds.length === 0) return new Map()
  const { data, error } = await createServiceClient()
    .from('registration')
    .select('id, user_id')
    .in('user_id', userIds)
    .returns<Array<{ id: string; user_id: string }>>()
  if (error) {
    console.error(`[blueprint] shared account registrations failed: ${error.message}`)
    return new Map()
  }
  return new Map(
    map(
      ([userId, regs = []]) => [userId, map((r: { id: string }) => r.id, regs)] as [string, string[]],
      Object.entries(groupBy((r: { user_id: string }) => r.user_id, data ?? []))
    )
  )
}

export const searchSharedBlueprints = async (query: string): Promise<SharedSearchResult> => {
  const trimmed = query.trim()
  if (trimmed.length < MIN_QUERY_LENGTH) return empty(trimmed)

  const { shared } = await resolveLibraries()
  if (shared.length === 0) return empty(trimmed)

  // Narrow to blueprint type ids FIRST, so each library is asked an indexed
  // `type_id in (…)` rather than scanned whole.
  const names = blueprintMatches(await searchSdeTypesAll(trimmed))
  const typeIds = [...names.keys()]
  if (typeIds.length === 0) return { query: trimmed, libraries: shared.length, results: [] }

  const userIds = uniq(chain((l: Library) => (l.subject.kind === 'account' ? [l.subject.userId] : []), shared))
  const regsByUser = await registrationsByUser(userIds)

  const answered = await Promise.all(
    map(async (library: Library): Promise<SharedSearchHit[]> => {
      const rows =
        library.subject.kind === 'corporation'
          ? await readCorp(library.subject.corporationId, typeIds)
          : await readAccount(regsByUser.get(library.subject.userId) ?? [], typeIds)
      const hits = foldHits(rows, names)
      return hits.length === 0
        ? []
        : [
            {
              key: library.key,
              href: library.href,
              label: library.label,
              kind: library.subject.kind,
              sharedBy: library.sharedBy,
              hits,
            },
          ]
    }, shared)
  )

  return {
    query: trimmed,
    libraries: shared.length,
    results: chain((hit: SharedSearchHit[]) => hit, answered),
  }
}
