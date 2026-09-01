import type { SupabaseClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { map, reduce } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { DateTime } from '../DateTime'
import { fetchOwners } from '../owners'
import { resolveLocations, type LocationRef } from '../resolveLocations'
import { AssetSearchForm } from './assetSearchForm'
import styles from './assets.module.css'
import { AssetsTable, type Location } from './assetsTable'
import { fetchLocationSummary } from './locationSummary'

const AssetsPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  // Kept as a child component so ./loading.tsx still covers the wait — it paints
  // the instant the link is clicked, rather than only once the server has
  // started responding, as an in-page Suspense fallback did. The buckets are no
  // longer expensive (see below), but the name-resolution pass behind them is
  // still several round trips.
  //
  // The client is handed down rather than made again so this runs against one
  // whose session is already resolved in memory.
  return <Locations supabase={supabase} />
}
export default AssetsPage

const Locations = async ({ supabase }: { supabase: SupabaseClient }) => {
  // A hangar can hold tens of thousands of nested items, and walking their
  // location_id chains is far too expensive to do per render — it was ~6.3s of
  // database time. The extract jobs now maintain that walk's result in
  // asset_location_summary_cache, so this is a small keyed read (0.2ms) and
  // joins the same batch as everything else the page needs.
  const [summary, owners, { data: lastRun }, { data: mainCharacter }] = await Promise.all([
    fetchLocationSummary(supabase),
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
      <p className={styles.corpses}>
        <Link href="/asset/shipping">Shipping calculator</Link>
      </p>
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
