import { redirect } from 'next/navigation'

import { indexesFlag } from '@/flags'
import { formatSecurity, getSdeSystem } from '@/sdeSystems'
import { createClient } from '@/utils/supabase/server'

import {
  fetchLatestSystemIndexes,
  fetchSystemIndexHistory,
  formatIndex,
  INDEX_ACTIVITY_LABELS,
  type Activity,
} from '../structure/industryIndex'
import { Sparkline } from '../structure/sparkline'
import { unwatchSystem } from './actions'
import { SystemSearch } from './systemSearch'
import { WindowSelect } from './windowSelect'
import { indexWindowOption } from './windows'
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
  const window = indexWindowOption(Number(daysParam))

  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  if (!(await indexesFlag())) {
    redirect('/')
  }

  // The caller's watched systems (RLS scopes the read), labelled from the
  // locally generated SDE data and sorted by name.
  const { data: watchedRows } = await supabase.from('watched_system').select('system_id')
  const systems = (watchedRows ?? [])
    .map((r) => {
      const id = Number(r.system_id)
      return { id, sde: getSdeSystem(id) }
    })
    .sort((a, b) => (a.sde?.name ?? String(a.id)).localeCompare(b.sde?.name ?? String(b.id)))
  const systemIds = systems.map((s) => s.id)

  const [latestBySystem, historyBySystem] = await Promise.all([
    fetchLatestSystemIndexes(supabase, systemIds),
    fetchSystemIndexHistory(supabase, systemIds, { days: window.days, bucketHours: window.bucketHours }),
  ])

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Indexes</h1>
        <WindowSelect days={window.days} />
      </div>

      {systems.length > 0 ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>System</th>
              {COLUMNS.map((activity) => (
                <th key={activity}>{INDEX_ACTIVITY_LABELS[activity]}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {systems.map(({ id, sde }) => {
              const latest = latestBySystem.get(id)
              const history = historyBySystem.get(id)
              return (
                <tr key={id}>
                  <td>
                    <span className={styles.system}>{sde?.name ?? `#${id}`}</span>{' '}
                    {sde && <span className={styles.security}>{formatSecurity(sde.security)}</span>}
                  </td>
                  {COLUMNS.map((activity) => {
                    const cost = latest?.get(activity)
                    const series = history?.get(activity)
                    return (
                      <td key={activity}>
                        {series || cost != null ? (
                          <span className={styles.cell}>
                            <Sparkline
                              values={series?.values ?? []}
                              liveCount={series?.liveCount}
                              updatedAt={series?.updatedAt}
                              label={`${sde?.name ?? id} ${INDEX_ACTIVITY_LABELS[activity]}`}
                            />
                            <span className={styles.current}>{cost != null ? formatIndex(cost) : '—'}</span>
                          </span>
                        ) : (
                          <span className={styles.empty}>—</span>
                        )}
                      </td>
                    )
                  })}
                  <td>
                    <form action={unwatchSystem}>
                      <input type="hidden" name="system_id" value={id} />
                      <button
                        type="submit"
                        className={styles.unwatch}
                        title={`Stop watching ${sde?.name ?? id}`}
                        aria-label={`Stop watching ${sde?.name ?? id}`}
                      >
                        ✕
                      </button>
                    </form>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
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
