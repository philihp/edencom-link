'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { copyLens } from './actions'
import styles from './lens.module.css'

// "Save a copy": fork a shared lens's query into the viewer's own list, then
// land them in the editor. Rendered on the viewer page for flagged non-owners
// and in the shared-with-me list on /lens.
export const CopyLensButton = ({ lensId, share }: { lensId: string; share?: string }) => {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const copy = () =>
    startTransition(async () => {
      setError(null)
      const copied = await copyLens(lensId, share)
      if (copied.error) setError(copied.error)
      else router.push('/lens')
    })

  return (
    <>
      <button type="button" onClick={copy} disabled={pending}>
        {pending ? 'Copying…' : 'Save a copy'}
      </button>
      {error && <span className={styles.error}>{error}</span>}
    </>
  )
}
