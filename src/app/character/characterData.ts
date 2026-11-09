// Per-character overview assembly, shared by /character and (from phase 2 of
// docs/registrations-page) /registration. Nothing here renders — the page owns
// the JSX, this owns "what do we know about each linked character": ISK,
// location, ship, clones, implants, and the industry job slots they occupy.
//
// The caller passes its own Supabase client (the codebase's pattern for
// helpers a second surface may reuse — see owners.ts), so RLS scoping stays
// wherever the caller established it.
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { ascend, reduce, sort, uniq } from 'ramda'

import {
  baseSlotMax,
  countJobSlots,
  emptyCounts,
  SKILL_FAMILY,
  SLOT_SKILL_IDS,
  type CharacterJobRow,
  type CorpJobRow,
  type SlotCounts,
  type SlotMax,
} from '../industry/jobSlots'
import { fetchSystemNames, fetchSystemPaths } from '../systemNames'
import { fetchTypeNames } from '../typeNames'
import { requiredScopes } from './scopes'
import { getEnabledScopes } from './userScopes'

export type CharacterOverview = {
  id: string // registration uuid
  characterId: number | null // EVE bigint id (may be null pre-callback)
  name: string
  balance: string | null // raw; formatBisk at render
  locationSystem: string | null
  ship: { itemId: string; label: string } | null
  cloneSystems: string[]
  implants: string[]
  // null when the character hasn't shared skills — slot capacity is never
  // guessed, the bubbles are simply not drawn.
  slots: { counts: SlotCounts; max: SlotMax } | null
}

export type CharacterOverviews = {
  characters: CharacterOverview[]
  error: PostgrestError | null
  status: number
  statusText: string
}

type WalletRow = { balance: string | null }

// The latest balance of one character. character_wallet is append-only (one
// row per extract run), so this is one probe of the (registration_id,
// recorded_at desc) index, as in MCP wallet_summary. The page used to read the
// whole history of every character and keep the newest row of each: that read
// grew with every run, and PostgREST cut it at 1000 rows, so a character whose
// last balance was older than the newest 1000 rows showed no balance.
const latestBalanceOf = async (supabase: SupabaseClient, registrationId: string): Promise<[string, string | null]> => {
  const { data } = await supabase
    .from('character_wallet')
    .select('balance')
    .eq('registration_id', registrationId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle<WalletRow>()
  return [registrationId, data?.balance ?? null]
}

export const fetchCharacterOverviews = async (supabase: SupabaseClient): Promise<CharacterOverviews> => {
  // Every read below needs only the session, except the balances, which need
  // the registration ids. So all of them start at once, and the balances start
  // when the registrations arrive. The page used to make these reads one after
  // the other: about a dozen round trips in series.
  const charactersPromise = supabase.from('registration').select()
  const balancesPromise = Promise.resolve(charactersPromise).then(({ data }) =>
    Promise.all((data ?? []).map((c) => latestBalanceOf(supabase, c.id as string)))
  )

  // Jobs that still hold a slot: running (status 'active') or ready to deliver
  // (status 'ready'). Corp jobs count against the installing character's slots
  // as well, so both listings feed the shared fold; RLS already scopes the corp
  // view to the caller's corporations.
  const [
    { data: characters, status, statusText, error },
    balances,
    { data: locations },
    { data: clones },
    { data: implantRows },
    { data: shipRows },
    { data: industryJobs },
    { data: corpIndustryJobs },
    { data: skillRows },
  ] = await Promise.all([
    charactersPromise,
    balancesPromise,
    supabase.from('character_location').select('registration_id, solar_system_id'),
    supabase.from('character_clone').select('registration_id, system_id'),
    supabase.from('character_implant').select('registration_id, type_ids'),
    supabase.from('character_ship').select('registration_id, ship_item_id, ship_type_id, ship_name'),
    supabase
      .from('character_industry_job')
      .select('job_id, registration_id, activity_id, status, end_date')
      .in('status', ['active', 'ready']),
    supabase
      .from('corp_industry_job')
      .select('job_id, installer_id, activity_id, status, end_date')
      .in('status', ['active', 'ready']),
    // Per-character slot ceilings, derived from the two skills behind each family.
    supabase
      .from('character_skill')
      .select('registration_id, skill_id, active_skill_level')
      .in('skill_id', SLOT_SKILL_IDS),
  ])

  const latestBalance = new Map(balances.filter((b): b is [string, string] => b[1] != null))

  // The names, all from the SDE mirror, also at once. One type lookup covers
  // the implants and the ships.
  const [systemNames, cloneSystemPaths, typeNames] = await Promise.all([
    fetchSystemNames((locations ?? []).map((l) => Number(l.solar_system_id))),
    fetchSystemPaths((clones ?? []).map((c) => Number(c.system_id))),
    fetchTypeNames([
      ...(implantRows ?? []).flatMap((r) => (r.type_ids ?? []).map(Number)),
      ...(shipRows ?? []).map((r) => Number(r.ship_type_id)),
    ]),
  ])

  const locationSystem = new Map(
    (locations ?? []).map((l) => [
      l.registration_id as string,
      systemNames[Number(l.solar_system_id)] ?? `System #${l.solar_system_id}`,
    ])
  )

  const cloneSystemsByCharacter = reduce(
    (acc, c) => {
      const system =
        c.system_id != null ? (cloneSystemPaths[Number(c.system_id)] ?? `System #${c.system_id}`) : 'Unknown'
      const existing = acc.get(c.registration_id as string) ?? []
      acc.set(c.registration_id as string, uniq([...existing, system]))
      return acc
    },
    new Map<string, string[]>(),
    clones ?? []
  )
  const cloneSystems = new Map(
    [...cloneSystemsByCharacter.entries()].map(([characterId, systems]) => [
      characterId,
      sort(
        ascend((s: string) => s),
        systems
      ),
    ])
  )

  const implantsByCharacter = new Map(
    (implantRows ?? []).map((r) => [
      r.registration_id as string,
      (r.type_ids ?? []).map((id: number) => typeNames[id] ?? `Type #${id}`),
    ])
  )

  const currentShip = new Map(
    (shipRows ?? []).map((r) => {
      const typeName = typeNames[Number(r.ship_type_id)] ?? `Type #${r.ship_type_id}`
      return [
        r.registration_id as string,
        {
          itemId: String(r.ship_item_id),
          label: r.ship_name && r.ship_name !== typeName ? `${r.ship_name} (${typeName})` : typeName,
        },
      ]
    })
  )

  const jobSlotCounts = countJobSlots({
    characterJobs: (industryJobs ?? []) as CharacterJobRow[],
    corpJobs: (corpIndustryJobs ?? []) as CorpJobRow[],
    registrationByCharacterId: new Map(
      (characters ?? []).filter((c) => c.character_id != null).map((c) => [String(c.character_id), c.id as string])
    ),
  })

  const slotMax = reduce(
    (acc, r) => {
      const family = SKILL_FAMILY[Number(r.skill_id)]
      if (family) {
        const max = acc.get(r.registration_id as string) ?? baseSlotMax()
        max[family] += Number(r.active_skill_level) || 0
        acc.set(r.registration_id as string, max)
      }
      return acc
    },
    new Map<string, SlotMax>(),
    skillRows ?? []
  )

  return {
    characters: (characters ?? []).map((c) => ({
      id: c.id as string,
      characterId: c.character_id == null ? null : Number(c.character_id),
      name: c.name as string,
      balance: latestBalance.has(c.id) ? latestBalance.get(c.id)! : null,
      locationSystem: locationSystem.get(c.id) ?? null,
      ship: currentShip.get(c.id) ?? null,
      cloneSystems: cloneSystems.get(c.id) ?? [],
      implants: implantsByCharacter.get(c.id) ?? [],
      // slotMax has an entry only when character_skill rows exist, so without
      // the scope we don't guess a capacity, we show nothing.
      slots: slotMax.has(c.id) ? { counts: jobSlotCounts.get(c.id) ?? emptyCounts(), max: slotMax.get(c.id)! } : null,
    })),
    error,
    status,
    statusText,
  }
}

// If the player has turned off every optional ESI scope, characters they add
// grant nothing beyond identification, so almost no features will work.
export const hasNoOptionalScopes = async (supabase: SupabaseClient, userId: string): Promise<boolean> => {
  const enabledScopes = await getEnabledScopes(supabase, userId)
  return enabledScopes.every((scope) => requiredScopes.includes(scope))
}
