import { notFound } from 'next/navigation'

import { searchSdeTypesAll } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

import styles from '../corpses.module.css'

// Modern capsuleer corpses are the gendered "Corpse Male"/"Corpse Female"
// types; "Corpse" is the legacy generic. They're singleton items, so the
// extract job resolves each one's ESI asset name, which for a corpse reads
// "<pilot>'s Frozen Corpse". Match on the SDE type name rather than a
// hardcoded id so a game patch adding a variant is picked up automatically
// (and NPC "…Frozen Corpse" types, which aren't named exactly this, stay out).
const CORPSE_TYPE_NAMES = new Set(['corpse', 'corpse male', 'corpse female'])

const corpseTypeIds = (): number[] =>
  searchSdeTypesAll('corpse')
    .filter((t) => CORPSE_TYPE_NAMES.has(t.name.toLowerCase()))
    .map((t) => t.typeID)

// A corpse first seen within this window is flagged "New!".
const NEW_WINDOW_MS = 48 * 60 * 60 * 1000

// Strip the "'s Frozen Corpse" suffix ESI tacks onto a corpse's name, leaving
// just the dead pilot's name. Straight or curly apostrophe, case-insensitive.
const pilotFromName = (name: string | null): string | null => {
  const trimmed = name?.trim()
  if (!trimmed) return null
  return trimmed.replace(/['’]s\s+Frozen\s+Corpse$/i, '').trim() || trimmed
}

// Public share page — no login required. It reads through the service-role
// client (bypassing RLS), so every query is explicitly scoped to the owning
// account's characters. Owners opt in by enabling the 'corpses' flag; a page
// for an account that hasn't is a 404, so this never leaks a random pilot's
// collection just because their character id was guessed.
export const dynamic = 'force-dynamic'

type RegistrationRow = {
  id: string
  user_id: string
  character_id: number | string | null
  name: string
  is_main: boolean
}

type CorpseRow = {
  item_id: number | string
  type_id: number | string
  name: string | null
  valid_from: string | null
}

const CorpsesPage = async ({ params }: { params: Promise<{ characterID: string }> }) => {
  const { characterID } = await params

  const service = createServiceClient()

  // Which account owns the character in the URL? Its registrations give us the
  // full set of characters whose corpses we list.
  const { data: owner } = await service
    .from('registration')
    .select('user_id')
    .eq('character_id', characterID)
    .limit(1)
    .maybeSingle<Pick<RegistrationRow, 'user_id'>>()
  if (!owner) notFound()

  // The owner must have opted into sharing by enabling the 'corpses' flag.
  const { data: settings } = await service
    .from('user_settings')
    .select('flags')
    .eq('user_id', owner.user_id)
    .maybeSingle<{ flags: string[] | null }>()
  if (!(settings?.flags ?? []).includes('corpses')) notFound()

  // Every character on the account, for both the corpse scope and the label.
  const { data: registrations } = await service
    .from('registration')
    .select('id, user_id, character_id, name, is_main')
    .eq('user_id', owner.user_id)
    .returns<RegistrationRow[]>()

  // The asset tables key on the registration row's uuid (character_asset.
  // character_id → registration.id), not the EVE character id, so scope the
  // corpse query by those uuids.
  const registrationIds = (registrations ?? []).map((r) => r.id)

  // Label the account by its main character, falling back to the character in
  // the URL, then any character on the account.
  const accountName =
    (registrations ?? []).find((r) => r.is_main)?.name ??
    (registrations ?? []).find((r) => String(r.character_id) === String(characterID))?.name ??
    (registrations ?? [])[0]?.name ??
    null

  const typeIds = corpseTypeIds()

  const { data: rows } =
    registrationIds.length && typeIds.length
      ? await service
          .from('character_asset')
          .select('item_id, type_id, name, valid_from')
          .in('character_id', registrationIds)
          .in('type_id', typeIds)
          .returns<CorpseRow[]>()
      : { data: [] as CorpseRow[] }

  const cutoff = Date.now() - NEW_WINDOW_MS

  // The pilot name lives in the asset name; a corpse whose name hasn't been
  // resolved yet falls back to its item id so it still shows in the tally.
  const corpses = (rows ?? [])
    .map((r) => {
      // valid_from is this asset version's debut (the SCD-2 validity window's
      // start) — for a corpse, effectively when it was first seen in the hangar.
      const firstSeenMs = r.valid_from ? new Date(r.valid_from).getTime() : NaN
      return {
        itemId: String(r.item_id),
        typeId: Number(r.type_id),
        pilot: pilotFromName(r.name),
        isNew: Number.isFinite(firstSeenMs) && firstSeenMs >= cutoff,
      }
    })
    .sort((a, b) => (a.pilot ?? '').localeCompare(b.pilot ?? '', undefined, { sensitivity: 'base' }))

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>{accountName ? `The Many Corpses of ${accountName}` : 'The Many Corpses'}</h1>
        {corpses.length > 0 && <span className={styles.count}>{corpses.length}</span>}
      </div>

      {corpses.length > 0 ? (
        <ul className={styles.grid}>
          {corpses.map(({ itemId, typeId, pilot, isNew }) => (
            <li key={itemId} className={styles.tile}>
              {isNew && <span className={styles.badge}>New!</span>}
              <img
                className={styles.icon}
                src={`https://images.evetech.net/types/${typeId}/icon?size=64`}
                alt=""
                width={48}
                height={48}
              />
              <span className={styles.name}>
                {pilot ?? <span className={styles.unknown}>Unknown (#{itemId})</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>No corpses in this collection.</p>
      )}
    </>
  )
}
export default CorpsesPage
