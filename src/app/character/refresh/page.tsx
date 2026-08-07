import Link from 'next/link'
import { redirect } from 'next/navigation'
import { reduce } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { isChancellor } from '../../account/settings/chancellor/chancellor'
import { Freshness } from '../../Freshness'
import { freshnessLevel } from '../../freshness'
import { CharacterName, Name } from '../../names'
import { RefreshButton } from './refreshButton'
import { RefreshPoller } from './poller'
import styles from './refresh.module.css'

// The per-character extract jobs, in column order, with a short column label
// for each (the full job names are named after their ESI endpoints and too
// wide for a table header).
const CHARACTER_JOBS = [
  ['character-assets', 'assets'],
  ['character-blueprints', 'blueprints'],
  ['character-orders', 'orders'],
  ['character-wallet-transactions', 'transactions'],
  ['character-industry-jobs', 'industry'],
  ['character-mercenary-dens', 'dens'],
  ['character-fittings', 'fittings'],
  // Combined live-state job: wallet, location, implants, and clones in one pull
  // (see src/jobs/characterStatus.js).
  ['character-status', 'status'],
] as const

// The corp-scoped extracts that can be kicked on demand. Each runs once per
// corporation, under whichever character's token carries both the OAuth scope
// and the in-game role the endpoint requires.
const CORP_JOBS = [
  ['corp-assets', 'assets'],
  ['corp-industry-jobs', 'industry'],
  ['corp-wallet-transactions', 'transactions'],
] as const

// Account-wide batch jobs — one run covers every registration at once.
const ACCOUNT_JOBS = [
  ['character-directory', 'characters'],
  ['universe-names', 'universe names'],
] as const

// Account-wide jobs whose on-demand refresh is reserved for Chancellors (see
// refreshCell in ./actions.ts). industry-systems pulls the whole game's
// industry cost indices in one shot — a heavier, no-auth ESI call with no
// per-character reason to kick it, so its row (and refresh button) only shows
// up for Chancellor accounts.
const CHANCELLOR_JOBS = [['industry-systems', 'industry indexes']] as const

// Always read fresh — the poller re-requests this server component every couple
// of seconds while any kicked-off job is still in flight.
export const dynamic = 'force-dynamic'

type Task = {
  id: string
  job: string
  registration_id: string | null
  status: string
  error: string | null
}

type Beat = {
  job: string
  registration_id: string | null
  corporation_id: number | null
  ended_at: string
}

const STATUS_LABEL: Record<string, string> = {
  running: '● running',
  pending: '· pending',
}

// One matrix cell: a just-kicked task shows its live status; otherwise the
// freshness dot for the job's last completed run, with a refresh button once
// it's yellow or red (or errored, or has never run at all).
const Cell = ({
  job,
  characterId,
  at,
  task,
}: {
  job: string
  characterId: string | null
  at?: string
  task?: Task
}) => {
  if (task && (task.status === 'pending' || task.status === 'running')) {
    return (
      <span className={styles.status} data-status={task.status}>
        {STATUS_LABEL[task.status]}
      </span>
    )
  }
  const errored = task?.status === 'error'
  return (
    <span className={styles.cell}>
      {errored ? (
        <span className={styles.status} data-status="error" title={task?.error ?? undefined}>
          ✗ error
        </span>
      ) : (
        <Freshness at={at} />
      )}
      {(errored || freshnessLevel(at) !== 'fresh') && <RefreshButton job={job} characterId={characterId} />}
    </span>
  )
}

const RefreshPage = async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  const chancellor = await isChancellor(user.id)

  // RLS scopes all of these to the caller: their registrations, their own
  // characters' heartbeats plus their corps' and the shared account-wide ones,
  // and their own refresh tasks.
  const { data: registrationsData } = await supabase
    .from('registration')
    .select('id, name, corporation_id')
    .order('created_at', { ascending: true })
  const registrations = registrationsData ?? []

  const { data: beatsData } = await supabase.rpc('latest_heartbeats')
  const beats = (beatsData ?? []) as Beat[]

  // Overlay recently dispatched refresh_task rows on the matrix so a kicked
  // cell shows pending/running/error. Floored to the last few minutes so a
  // message that was lost before ever flipping its row terminal doesn't pin a
  // cell (and the poller) on "pending" forever.
  const taskFloor = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data: tasksData } = await supabase
    .from('refresh_task')
    .select('id, job, registration_id, status, error')
    .gte('created_at', taskFloor)
    .order('created_at', { ascending: true })
  const tasks = (tasksData ?? []) as Task[]

  const corporationOf = new Map(registrations.map((r) => [r.id, r.corporation_id]))

  // latest_heartbeats returns one row per job per owner. Character- and
  // account-scoped rows are already unique per cell; corp rows can appear once
  // per character that has ever run the corp's pull, so keep the newest — its
  // registration_id is whose token the extract actually ran under last time.
  const { charBeats, corpBeats, accountBeats, corpRunsAs } = reduce(
    (acc, b: Beat) => {
      if (b.corporation_id != null) {
        const key = `${b.job}:${b.corporation_id}`
        const prev = acc.corpBeats.get(key)
        if (!prev || prev.ended_at < b.ended_at) acc.corpBeats.set(key, b)
        const prevRun = acc.corpRunsAs.get(b.corporation_id)
        if (!prevRun || prevRun.ended_at < b.ended_at) acc.corpRunsAs.set(b.corporation_id, b)
      } else if (b.registration_id != null) {
        acc.charBeats.set(`${b.job}:${b.registration_id}`, b.ended_at)
      } else {
        acc.accountBeats.set(b.job, b.ended_at)
      }
      return acc
    },
    {
      charBeats: new Map<string, string>(),
      corpBeats: new Map<string, Beat>(),
      accountBeats: new Map<string, string>(),
      corpRunsAs: new Map<number, Beat>(),
    },
    beats
  )

  // Index the recent tasks by cell, later rows winning. A corp job's task row
  // carries its representative character, so key those by the corp instead.
  const corpJobNames = new Set<string>(CORP_JOBS.map(([job]) => job))
  const taskByCell = reduce(
    (acc, t) => {
      const corpId = corpJobNames.has(t.job) && t.registration_id != null ? corporationOf.get(t.registration_id) : null
      return acc.set(`${t.job}:${corpId ?? t.registration_id ?? ''}`, t)
    },
    new Map<string, Task>(),
    tasks
  )
  const anyActive = tasks.some((t) => t.status === 'pending' || t.status === 'running')

  // The user's corporations, each with the registered characters in it (in
  // registration order — the representative dispatchRefresh would pick first).
  const corporations = reduce(
    (acc, r) => {
      if (r.corporation_id == null) return acc
      const group = acc.get(r.corporation_id)
      if (group) group.push(r)
      else acc.set(r.corporation_id, [r])
      return acc
    },
    new Map<number, typeof registrations>(),
    registrations
  )

  const corporationIds = [...corporations.keys()]
  const { data: corpNamesData } = corporationIds.length
    ? await supabase.from('universe_name').select('id, name').in('id', corporationIds)
    : { data: [] }
  const corpName = new Map((corpNamesData ?? []).map((n) => [Number(n.id), n.name as string]))

  return (
    <>
      <h1>Refresh ESI</h1>
      <p>
        Extracts run on their own schedule (every 6 hours for most, daily for corp assets and the character directory);
        nothing starts just by opening this page. A cell shows when its job last ran — green within 15 minutes, yellow
        within 6 hours, red beyond that — and stale cells can be refreshed one at a time.
      </p>

      {registrations.length === 0 ? (
        <p>
          No characters registered yet. Add one on the <Link href="/character">Characters</Link> page.
        </p>
      ) : (
        <>
          <h2>Characters</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Character</th>
                {CHARACTER_JOBS.map(([job, label]) => (
                  <th key={job}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {registrations.map((r) => (
                <tr key={r.id}>
                  <td>
                    <CharacterName name={r.name} />
                  </td>
                  {CHARACTER_JOBS.map(([job]) => (
                    <td key={job}>
                      <Cell
                        job={job}
                        characterId={r.id}
                        at={charBeats.get(`${job}:${r.id}`)}
                        task={taskByCell.get(`${job}:${r.id}`)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {corporations.size > 0 && (
            <>
              <h2>Corporations</h2>
              <p>
                Corp extracts run once per corporation, under the token of the character with the in-game role —
                director or the like — the endpoint requires. The token column shows whose token the last pull ran
                under.
              </p>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Corporation</th>
                    <th>Token</th>
                    {CORP_JOBS.map(([job, label]) => (
                      <th key={job}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...corporations.entries()].map(([corporationId, members]) => {
                    const runsAs = corpRunsAs.get(corporationId)
                    const owned = members.find((m) => m.id === runsAs?.registration_id)
                    // Kick new pulls as the character the last one succeeded
                    // under when it's ours; the queue message carries the whole
                    // corp group either way, so this only picks the row's
                    // representative.
                    const representative = owned ?? members[0]
                    return (
                      <tr key={corporationId}>
                        <td>
                          <Name name={corpName.get(corporationId)} id={corporationId} />
                        </td>
                        <td>
                          {runsAs ? (
                            owned ? (
                              <CharacterName name={owned.name} />
                            ) : (
                              // The last pull ran under a corpmate's token on
                              // another account — visible via the corp-scoped
                              // heartbeat, but not a registration we can name.
                              <span className={styles.tokenNote}>a corpmate&apos;s</span>
                            )
                          ) : (
                            <CharacterName name={representative.name} />
                          )}
                        </td>
                        {CORP_JOBS.map(([job]) => (
                          <td key={job}>
                            <Cell
                              job={job}
                              characterId={representative.id}
                              at={corpBeats.get(`${job}:${corporationId}`)?.ended_at}
                              task={taskByCell.get(`${job}:${corporationId}`)}
                            />
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}

          <h2>Account-wide</h2>
          <table className={styles.table}>
            <tbody>
              {ACCOUNT_JOBS.map(([job, label]) => (
                <tr key={job}>
                  <td>{label}</td>
                  <td>
                    <Cell job={job} characterId={null} at={accountBeats.get(job)} task={taskByCell.get(`${job}:`)} />
                  </td>
                </tr>
              ))}
              {chancellor &&
                CHANCELLOR_JOBS.map(([job, label]) => (
                  <tr key={job}>
                    <td>{label}</td>
                    <td>
                      <Cell job={job} characterId={null} at={accountBeats.get(job)} task={taskByCell.get(`${job}:`)} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}

      <RefreshPoller done={!anyActive} />
    </>
  )
}

export default RefreshPage
