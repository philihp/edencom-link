'use client'

import { useRef, useState, useTransition } from 'react'

import type { SaveShareInput, SaveShareResult } from './shareActions'
import type { ShareDialogData, ShareState } from './shareData'
import styles from './shareDialog.module.css'

type ShareDialogProps = {
  // What the dialog says it's sharing ("ship", "item", "fitting").
  subjectLabel: string
  // The path a share link opens (e.g. `/ship/123`); the client appends
  // ?share=<param> to the current origin.
  urlPath: string
  data: ShareDialogData
  // Server-action references, bound to the subject by the server component
  // (e.g. saveAssetShare.bind(null, itemId)) — this is what lets the one
  // dialog drive asset AND fitting shares.
  save: (input: SaveShareInput) => Promise<SaveShareResult>
  revoke: () => Promise<{ error?: string }>
}

// The Share button + native <dialog> editor over a subject's single share row
// (docs/sharing-layer/03-share-dialog.md): corporation/alliance checkboxes,
// a signed share link, or fully public — saved via cookie-session server
// actions. Rendered only when the viewer owns the subject.
export const ShareDialog = ({
  subjectLabel,
  urlPath,
  data,
  save: saveAction,
  revoke: revokeAction,
}: ShareDialogProps) => {
  const ref = useRef<HTMLDialogElement>(null)
  const [share, setShare] = useState<ShareState | null>(data.share)
  const [corporationIds, setCorporationIds] = useState<Set<number>>(new Set(data.share?.corporationIds ?? []))
  const [allianceIds, setAllianceIds] = useState<Set<number>>(new Set(data.share?.allianceIds ?? []))
  const [link, setLink] = useState(data.share?.hasLink ?? false)
  const [isPublic, setIsPublic] = useState(data.share?.isPublic ?? false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const shareUrl =
    share?.shareParam && typeof window !== 'undefined'
      ? `${window.location.origin}${urlPath}?share=${share.shareParam}`
      : null

  const toggle = (set: Set<number>, id: number): Set<number> => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  const save = (rotateLink = false) =>
    startTransition(async () => {
      setError(null)
      const result = await saveAction({
        corporationIds: [...corporationIds],
        allianceIds: [...allianceIds],
        link,
        rotateLink,
        isPublic,
      })
      if (result.error) setError(result.error)
      else if (result.share) {
        setShare(result.share)
        setCopied(false)
      }
    })

  const stopSharing = () =>
    startTransition(async () => {
      setError(null)
      const result = await revokeAction()
      if (result.error) setError(result.error)
      else {
        setShare(null)
        setCorporationIds(new Set())
        setAllianceIds(new Set())
        setLink(false)
        setIsPublic(false)
        setCopied(false)
      }
    })

  const copy = async () => {
    if (!shareUrl) return
    await navigator.clipboard.writeText(shareUrl)
    setCopied(true)
  }

  return (
    <>
      <button type="button" onClick={() => ref.current?.showModal()}>
        Share{share ? 'd' : ''}
      </button>
      <dialog ref={ref} className={styles.dialog}>
        <h2>Share this {subjectLabel}</h2>
        <p className={styles.hint}>
          Whoever you share with can see this item and everything inside it, live, until you stop sharing.
        </p>

        <label className={styles.publicRow}>
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          Public — anyone can see this
        </label>

        <fieldset className={styles.audience} disabled={isPublic}>
          <legend>Corporations</legend>
          {data.corporations.length === 0 ? (
            <p className={styles.hint}>None of your characters are in a corporation.</p>
          ) : (
            data.corporations.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={corporationIds.has(c.id)}
                  onChange={() => setCorporationIds((s) => toggle(s, c.id))}
                />
                {c.name}
              </label>
            ))
          )}
        </fieldset>

        <fieldset className={styles.audience} disabled={isPublic}>
          <legend>Alliances</legend>
          {data.alliances.length === 0 ? (
            <p className={styles.hint}>None of your corporations are in an alliance.</p>
          ) : (
            data.alliances.map((a) => (
              <label key={a.id}>
                <input
                  type="checkbox"
                  checked={allianceIds.has(a.id)}
                  onChange={() => setAllianceIds((s) => toggle(s, a.id))}
                />
                {a.name}
              </label>
            ))
          )}
        </fieldset>

        <fieldset className={styles.audience} disabled={isPublic}>
          <legend>Share link</legend>
          <label>
            <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
            Anyone with the link can see this
          </label>
          {shareUrl && link ? (
            <p className={styles.linkRow}>
              <code>{shareUrl}</code>{' '}
              <button type="button" onClick={copy} disabled={pending}>
                {copied ? 'copied' : 'copy'}
              </button>{' '}
              <button type="button" onClick={() => save(true)} disabled={pending} title="Old links stop working">
                reset link
              </button>
            </p>
          ) : null}
        </fieldset>

        {data.hasLegacyToken ? (
          <p className={styles.hint}>An old-style ?token= link exists for this item; saving replaces it.</p>
        ) : null}
        {error ? <p className={styles.error}>{error}</p> : null}

        <div className={styles.footer}>
          <button type="button" onClick={() => save()} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
          {share ? (
            <button type="button" onClick={stopSharing} disabled={pending}>
              Stop sharing
            </button>
          ) : null}
          <button type="button" onClick={() => ref.current?.close()} disabled={pending}>
            Close
          </button>
        </div>
      </dialog>
    </>
  )
}
