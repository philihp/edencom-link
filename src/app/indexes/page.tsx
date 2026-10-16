import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { formatSecurity, getSdeSystems } from '@/sdeSystems'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'

import { fetchLatestSystemIndexes, fetchSystemIndexHistory, type Activity } from '../structure/industryIndex'
import { SystemSearch } from './systemSearch'
import { WatchedSystemsTable, type WatchedRow } from './watchedSystemsTable'
import { UrlWindowSelect } from '../windowSelect'
import { indexWindowOption } from './windows'
import { parseProductionOnly, PRODUCTION_ONLY_COOKIE, visibleColumns } from './productionOnly'
import { ProductionOnlyToggle } from './productionOnlyToggle'
import styles from './indexes.module.css'

// One column per industry cost index, in this order.
const COLUMNS: Activity[] = [
  'manufacturing',
  'researching_material_efficiency',
  'researching_time_efficiency',
  'copying',
  'invention',
  'reaction',
]

// Always read fresh — the watch list and the hourly index snapshots both move
// underneath this page.
export const dynamic = 'force-dynamic'

const IndexesPage = async ({ searchParams }: { searchParams: Promise<{ days?: string }> }) => {
  const { days: daysParam } = await searchParams
  const window = indexWindowOption(daysParam)
  const productionOnly = parseProductionOnly((await cookies()).get(PRODUCTION_ONLY_COOKIE)?.value)
  const columns = visibleColumns(COLUMNS, productionOnly)

  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  // The caller's watched systems (RLS scopes the read), in the user's own
  // drag order, labelled from the nightly-mirrored SDE (one bulk lookup).
  const { data: watchedRows } = await supabase
    .from('watched_system')
    .select('system_id')
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  const watchedIds = (watchedRows ?? []).map((r) => Number(r.system_id))
  const sdeSystems = await getSdeSystems(watchedIds)
  const systems = watchedIds.map((id) => ({ id, sde: sdeSystems[id] ?? null }))
  const systemIds = systems.map((s) => s.id)

  const [latestBySystem, historyBySystem] = await Promise.all([
    fetchLatestSystemIndexes(supabase, systemIds),
    fetchSystemIndexHistory(supabase, systemIds, { days: window.days, bucketHours: window.bucketHours }),
  ])

  const rows: WatchedRow[] = systems.map(({ id, sde }) => {
    const latest = latestBySystem.get(id)
    const history = historyBySystem.get(id)
    return {
      id,
      name: sde?.name ?? `#${id}`,
      security: sde ? formatSecurity(sde.security) : null,
      cells: columns.map((activity) => ({
        activity,
        cost: latest?.get(activity) ?? null,
        series: history?.get(activity) ?? null,
      })),
    }
  })

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Indexes</h1>
        <div className={styles.headerControls}>
          <ProductionOnlyToggle on={productionOnly} />
          <UrlWindowSelect days={window.days} path="/indexes" />
        </div>
      </div>

      {rows.length > 0 ? (
        // Keyed on the id set + window (not the drag order) so a reorder
        // doesn't remount — only adding/removing a watched system, switching
        // the time window, or the production-only toggle does. That re-syncs the table's local
        // drag state and sparkline data to the server's canonical values.
        <WatchedSystemsTable
          key={`${[...systemIds].sort((a, b) => a - b).join(',')}-${window.days}-${productionOnly}`}
          columns={columns}
          rows={rows}
        />
      ) : (
        <p>
          No watched systems yet. Search below to add one — its cost indices are picked up by the next hourly extract.
        </p>
      )}

      <h2>Watch a system</h2>
      <SystemSearch />
    </>
  )
}
export default IndexesPage
