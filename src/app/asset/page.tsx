import Link from 'next/link'
import { redirect } from 'next/navigation'
import { map, reduce } from 'ramda'

import { createClient } from '@/utils/supabase/server'
import { DateTime } from '../DateTime'
import { fetchOwners } from '../owners'
import { resolveLocations, type LocationRef } from '../resolveLocations'
import { AssetSearchForm } from './assetSearchForm'
import styles from './assets.module.css'
import { AssetsTable, type Location } from './assetsTable'

// Bigint ids arrive from PostgREST as strings, so every id is kept as a string
// and only converted to a number at the API/system-lookup boundary.
type CharacterSummaryRow = {
  location_id: number | string
  location_type: string | null
  registration_id: string
  stacks: number | string
}

type CorpSummaryRow = {
  location_id: number | string
  location_type: string | null
  corporation_id: number | string
  stacks: number | string
}

// A summary row from either source, keyed by whoever owns the stacks: a
// character (registration uuid) or a corporation (EVE corporation id).
type SummaryRow = {
  location_id: number | string
  location_type: string | null
  owner_id: string
  stacks: number | string
}

const AssetsPage = async () => {
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  // The location buckets are expensive to build (two location-summary RPCs plus
  // a name-resolution pass), so the wait is covered by ./loading.tsx — which
  // paints the instant the link is clicked, rather than only once the server
  // has started responding, as an in-page Suspense fallback did.
  return <Locations />
}
export default AssetsPage

const Locations = async () => {
  const supabase = await createClient()

  // A hangar can hold tens of thousands of nested items; paging them all into
  // Node and walking the location_id chains here timed the page out. The
  // *_asset_location_summary() functions do the walk in Postgres and return one
  // small row per location/owner pair instead (RLS still scopes character rows
  // to us and corp rows to corps we have a registered character in). The
  // "last refreshed" heartbeat doesn't depend on any of this, so it's fetched
  // in the same batch instead of after everything else resolves.
  const [{ data: characterSummary }, { data: corpSummary }, owners, { data: lastRun }, { data: mainCharacter }] =
    await Promise.all([
      supabase.rpc('character_asset_location_summary'),
      supabase.rpc('corp_asset_location_summary'),
      fetchOwners(),
      supabase
        .from('heartbeat')
        .select('ended_at, run_url')
        .eq('job', 'character-assets')
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      // The corpses share page is keyed on a character id; link the signed-in
      // user to their own (their main character's), like the header used to.
      supabase
        .from('registration')
        .select('character_id')
        .order('is_main', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
    ])
  const mainCharacterId = mainCharacter?.character_id ?? null

  const summary: SummaryRow[] = [
    ...map(
      (row: CharacterSummaryRow): SummaryRow => ({ ...row, owner_id: row.registration_id }),
      (characterSummary ?? []) as CharacterSummaryRow[]
    ),
    ...map(
      (row: CorpSummaryRow): SummaryRow => ({ ...row, owner_id: String(row.corporation_id) }),
      (corpSummary ?? []) as CorpSummaryRow[]
    ),
  ]

  // Tally stacks per location, split by the owner (character or corporation)
  // of each stack so the client can filter by owner.
  const byLocation = reduce(
    (acc, row) => {
      const id = String(row.location_id)
      const entry = acc.get(id) ?? { root: { id, type: row.location_type }, counts: new Map<string, number>() }
      entry.counts.set(row.owner_id, (entry.counts.get(row.owner_id) ?? 0) + Number(row.stacks))
      return acc.set(id, entry)
    },
    new Map<string, { root: LocationRef; counts: Map<string, number> }>(),
    summary
  )

  const { nameFor, systemFor } = await resolveLocations(map(({ root }) => root, [...byLocation.values()]))

  const locations: Location[] = map(
    ({ root, counts }) => ({
      id: root.id,
      name: nameFor(root),
      system: systemFor(root) ?? null,
      counts: Object.fromEntries(counts),
    }),
    [...byLocation.values()]
  )

  return (
    <>
      {mainCharacterId != null && (
        <p className={styles.corpses}>
          <Link href={`/corpses/${mainCharacterId}`}>View frozen corpses</Link>
        </p>
      )}
      <AssetSearchForm />
      <AssetsTable locations={locations} owners={owners} />
      <p className={styles.lastRun}>
        Assets last refreshed:{' '}
        {lastRun?.run_url ? (
          <a href={lastRun.run_url}>
            <DateTime value={lastRun.ended_at} fallback="never" />
          </a>
        ) : (
          <DateTime value={lastRun?.ended_at} fallback="never" />
        )}
      </p>
    </>
  )
}
