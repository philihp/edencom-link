'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { refreshCell } from './actions'
import styles from './refresh.module.css'

// Kicks one job for one cell without leaving the page. The follow-up
// router.refresh() re-renders the server matrix, which now has a pending
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
