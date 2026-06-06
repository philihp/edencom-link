import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { RefreshPoller } from './poller'
import styles from './refresh.module.css'

// Matches the per-character jobs the Refresh ESI action fans out, in column order.
const JOBS = ['assets', 'hourly', 'structures', 'orders'] as const

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

const StatusCell = ({ task }: { task?: Task }) => {
  const status = task?.status ?? 'pending'
  return (
    <span className={styles.status} data-status={status} title={task?.error ?? undefined}>
      {STATUS_LABEL[status] ?? status}
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
                  <StatusCell task={byCharJob.get(`${id}:${job}`)} />
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
