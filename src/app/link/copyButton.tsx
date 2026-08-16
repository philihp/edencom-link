'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { copyLink } from './actions'
import styles from './link.module.css'

// "Save a copy": fork a shared link's query into the viewer's own list, then
// land them in the editor. Rendered on the viewer page for flagged non-owners
// and in the shared-with-me list on /link.
export const CopyLinkButton = ({ linkId, share }: { linkId: string; share?: string }) => {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const copy = () =>
    startTransition(async () => {
      setError(null)
      const copied = await copyLink(linkId, share)
      if (copied.error) setError(copied.error)
      else router.push('/link')
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
