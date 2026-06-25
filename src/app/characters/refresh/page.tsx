import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { DateTime } from '../../DateTime'
import { RefreshPoller } from './poller'
import styles from './refresh.module.css'

// Matches the per-character jobs the Refresh ESI action fans out, in column order.
// `structures` isn't fanned out per character (it runs on a daily cron), so it's
// not a column here.
const JOBS = ['assets', 'hourly', 'orders'] as const

// Always read fresh — the poller re-requests this server component every couple of
// seconds while a refresh is in flight.
export const dynamic = 'force-dynamic'

type Task = {
  id: string
  job: string
  character_id: string | null
  character_name: string | null
  status: string
  started_at: string | null
  ended_at: string | null
  error: string | null
}

const STATUS_LABEL: Record<string, string> = {
  done: '✓ done',
  running: '● running',
  error: '✗ error',
  pending: '· pending',
}

const StatusCell = ({ task, lastSuccessAt }: { task?: Task; lastSuccessAt?: string | null }) => {
  // No task means this job wasn't queued in this refresh — fall back to when it
  // last completed successfully for this character (across earlier refreshes).
  if (!task) {
    return (
      <span className={styles.status} data-status="idle">
        {lastSuccessAt ? (
          <>
            last ✓ <DateTime value={lastSuccessAt} />
          </>
        ) : (
          'never run'
        )}
      </span>
    )
  }
  return (
    <span className={styles.status} data-status={task.status} title={task.error ?? undefined}>
      {STATUS_LABEL[task.status] ?? task.status}
    </span>
  )
}

const RefreshPage = async ({ searchParams }: { searchParams: Promise<{ batch?: string }> }) => {
  const { batch } = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    redirect('/account/login')
  }

  if (!batch) {
    return (
      <>
        <h1>Refresh ESI</h1>
        <p>
          No refresh in progress. Start one from the <Link href="/character">Characters</Link> page.
        </p>
      </>
    )
  }

  const { data: tasksData } = await supabase
    .from('refresh_task')
    .select('id, job, character_id, character_name, status, started_at, ended_at, error')
    .eq('batch_id', batch)
    .order('created_at', { ascending: true })
  const tasks = (tasksData ?? []) as Task[]

  // Index the per-character tasks by character+job for the matrix; the daily task
  // is account-wide so it stands on its own.
  const byCharJob = new Map<string, Task>()
  const characters = new Map<string, string>()
  let daily: Task | undefined
  for (const t of tasks) {
    if (t.character_id) {
      byCharJob.set(`${t.character_id}:${t.job}`, t)
      characters.set(t.character_id, t.character_name ?? t.character_id)
    } else if (t.job === 'daily') {
      daily = t
    }
  }

  const isTerminal = (status: string) => status === 'done' || status === 'error'
  const allDone = tasks.length > 0 && tasks.every((t) => isTerminal(t.status))

  if (tasks.length === 0) {
    return (
      <>
        <h1>Refresh ESI</h1>
        <p>No tasks found for this refresh.</p>
        <p>
          <Link href="/character">← Back to Characters</Link>
        </p>
      </>
    )
  }

  // For matrix cells with no task in this batch, look up the last successful run
  // of that job for the character (any earlier refresh). One query for all of the
  // batch's characters, reduced to the most recent `done` per character+job.
  const charIds = [...characters.keys()]
  const lastSuccess = new Map<string, string>()
  const { data: doneData } = await supabase
    .from('refresh_task')
    .select('character_id, job, ended_at')
    .eq('status', 'done')
    .in('character_id', charIds)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
  for (const r of doneData ?? []) {
    const key = `${r.character_id}:${r.job}`
    if (!lastSuccess.has(key)) lastSuccess.set(key, r.ended_at) // first seen = most recent
  }

  return (
    <>
      <h1>Refresh ESI</h1>
      <p>{allDone ? 'All jobs finished.' : 'Refreshing… this page updates automatically.'}</p>

      {daily && (
        <p>
          Account-wide <strong>daily</strong>: <StatusCell task={daily} />
        </p>
      )}

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Character</th>
            {JOBS.map((job) => (
              <th key={job}>{job}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...characters.entries()].map(([id, name]) => (
            <tr key={id}>
              <td>{name}</td>
              {JOBS.map((job) => (
                <td key={job}>
                  <StatusCell task={byCharJob.get(`${id}:${job}`)} lastSuccessAt={lastSuccess.get(`${id}:${job}`)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        <Link href="/character">← Back to Characters</Link>
      </p>

      <RefreshPoller done={allDone} />
    </>
  )
}

export default RefreshPage
