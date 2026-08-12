'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

// Re-render the server page on an interval until every task has reached a terminal
// state, so the page updates live without a manual reload.
export const RefreshPoller = ({ done }: { done: boolean }) => {
  const router = useRouter()
  useEffect(() => {
    if (done) return
    const id = setInterval(() => router.refresh(), 2000)
    return () => clearInterval(id)
  }, [done, router])
  return null
}
