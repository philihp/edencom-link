'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { refreshAllCharacters, refreshCell } from './actions'
import styles from './jobs.module.css'

// Kicks one job for one cell without leaving the page. The follow-up
// router.refresh() re-renders the server page, which now has a pending
// refresh_task for the cell, and the poller takes over until it settles.
export const RefreshButton = ({ job, characterId }: { job: string; characterId: string | null }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      className={styles.refreshButton}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await refreshCell(job, characterId)
          router.refresh()
        })
      }
    >
      {pending ? 'refreshing…' : 'refresh'}
    </button>
  )
}

// The same thing for a whole Characters row: one click kicks the job for every
// registered character instead of one cell at a time. Lives inside the row's
// expansion, next to the per-character cells it stands in for.
export const RefreshAllButton = ({ job }: { job: string }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      className={styles.refreshButton}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await refreshAllCharacters(job)
          router.refresh()
        })
      }
    >
      {pending ? 'refreshing everyone…' : 'refresh everyone'}
    </button>
  )
}
