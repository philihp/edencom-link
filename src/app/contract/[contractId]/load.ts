import { fromPairs, map, uniq } from 'ramda'

import type { createClient } from '@/utils/supabase/server'

import { resolveLocations } from '../../resolveLocations'
import { fetchTypeNames } from '../../typeNames'
import {
  CONTRACT_PAGE_COLUMNS,
  locationIds,
  partyIds,
  pickContract,
  splitItems,
  statusHistory,
  type ContractLines,
  type ContractOwner,
  type ContractRow,
  type StatusRow,
  type StatusStep,
} from './contract'

// The reads behind /contract/[contractId]. Every read is on the caller's
// cookie session, so RLS decides: a contract that no character or
// corporation of the caller is party to has no row, and the page is a 404.

type Supabase = Awaited<ReturnType<typeof createClient>>
type Num = number | string
type ItemRow = {
  record_id: Num
  type_id: Num
  quantity: Num
  is_included: boolean
  is_singleton: boolean
  raw_quantity: Num | null
}
type StatusViewRow = { status: string; valid_from: string; valid_until: string }

const ITEM_COLUMNS = 'record_id, type_id, quantity, is_included, is_singleton, raw_quantity'
const STATUS_COLUMNS = 'status, valid_from, valid_until'

export type ContractPageData = {
  contract: ContractRow
  lines: ContractLines
  history: StatusStep[]
  // The name of our side of the row: a character or a corporation.
  ownerName: string | null
  parties: Record<number, string>
  locations: Record<number, string>
  types: Record<number, string>
}

const withOwner =
  (owner: (r: Record<string, unknown>) => ContractOwner) =>
  <T extends Record<string, unknown>>(rows: T[] | null) =>
    map((r: T) => ({ ...r, owner: owner(r) }), rows ?? [])

const characterOwner = (r: Record<string, unknown>): ContractOwner => ({
  kind: 'character',
  registrationId: String(r.registration_id),
})
const corporationOwner = (r: Record<string, unknown>): ContractOwner => ({
  kind: 'corporation',
  corporationId: Number(r.corporation_id),
})

// The parties' names: universe_name first, then the public directories for
// an id the universe-names job has not reached.
const fetchPartyNames = async (supabase: Supabase, ids: number[]): Promise<Record<number, string>> => {
  if (ids.length === 0) return {}
  const [universe, characters, corporations] = await Promise.all([
    supabase.from('universe_name').select('id, name').in('id', ids),
    supabase.from('character_directory').select('character_id, name').in('character_id', ids),
    supabase.from('corporation').select('corporation_id, name').in('corporation_id', ids),
  ])
  const pairs = (rows: Array<Record<string, unknown>> | null, key: string): Array<[number, string]> =>
    (rows ?? []).flatMap((r) => (r.name == null ? [] : [[Number(r[key]), String(r.name)] as [number, string]]))
  return fromPairs([
    ...pairs(corporations.data, 'corporation_id'),
    ...pairs(characters.data, 'character_id'),
    ...pairs(universe.data, 'id'),
  ]) as unknown as Record<number, string>
}

// An NPC station id sits in 60,000,000–64,000,000; a larger id is a player
// structure, which resolveLocations finds by id without a type.
const locationType = (id: number): string | null => (id >= 60_000_000 && id < 64_000_000 ? 'station' : null)

const fetchLocationNames = async (supabase: Supabase, ids: number[]): Promise<Record<number, string>> => {
  if (ids.length === 0) return {}
  const refs = map((id: number) => ({ id: String(id), type: locationType(id) }), ids)
  const resolved = await resolveLocations(refs, supabase)
  return fromPairs(
    map((ref): [string, string] => {
      const system = resolved.systemFor(ref)
      const name = resolved.nameFor(ref)
      return [ref.id, system != null && !name.startsWith(system) ? `${name} (${system})` : name]
    }, refs)
  ) as unknown as Record<number, string>
}

export const loadContractPage = async (supabase: Supabase, contractId: number): Promise<ContractPageData | null> => {
  const [characterRows, corpRows] = await Promise.all([
    supabase
      .from('character_contract_with_status')
      .select(`registration_id, ${CONTRACT_PAGE_COLUMNS}`)
      .eq('contract_id', contractId),
    supabase
      .from('corp_contract_with_status')
      .select(`corporation_id, ${CONTRACT_PAGE_COLUMNS}`)
      .eq('contract_id', contractId),
  ])
  const rows = [
    ...withOwner(characterOwner)(characterRows.data as Array<Record<string, unknown>> | null),
    ...withOwner(corporationOwner)(corpRows.data as Array<Record<string, unknown>> | null),
  ] as unknown as ContractRow[]
  const contract = pickContract(rows)
  if (contract === null) return null

  const { owner } = contract
  const itemsTable = owner.kind === 'character' ? 'character_contract_item' : 'corp_contract_item'
  const statusTable =
    owner.kind === 'character' ? 'character_contract_status_over_time' : 'corp_contract_status_over_time'
  const ownerColumn = owner.kind === 'character' ? 'registration_id' : 'corporation_id'
  const ownerValue = owner.kind === 'character' ? owner.registrationId : owner.corporationId

  const ownerNamePromise =
    owner.kind === 'character'
      ? supabase
          .from('registration')
          .select('name')
          .eq('id', owner.registrationId)
          .maybeSingle()
          .then(({ data }) => (data?.name as string | undefined) ?? null)
      : Promise.resolve(null)

  const [items, statuses, ownerName, parties, locations] = await Promise.all([
    supabase.from(itemsTable).select(ITEM_COLUMNS).eq(ownerColumn, ownerValue).eq('contract_id', contractId),
    supabase.from(statusTable).select(STATUS_COLUMNS).eq(ownerColumn, ownerValue).eq('contract_id', contractId),
    ownerNamePromise,
    fetchPartyNames(
      supabase,
      uniq([...partyIds(contract), ...(owner.kind === 'corporation' ? [owner.corporationId] : [])])
    ),
    fetchLocationNames(supabase, locationIds(contract)),
  ])

  const lines = splitItems((items.data ?? []) as ItemRow[])
  const history = statusHistory(
    owner,
    map((r: StatusViewRow): StatusRow => ({ ...r, owner }), (statuses.data ?? []) as StatusViewRow[])
  )
  const types = await fetchTypeNames(uniq(map((l) => l.typeId, [...lines.offered, ...lines.asked])))

  return {
    contract,
    lines,
    history,
    ownerName: owner.kind === 'character' ? ownerName : (parties[owner.corporationId] ?? null),
    parties,
    locations,
    types,
  }
}
