'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'

import { deleteMarshalledAction, unmarshalFittingAction } from '../marshalActions'
import { targetLabel, type UnmarshalTarget } from './slots'
import dialogStyles from '../../asset/shareDialog.module.css'
import styles from '../fittings.module.css'

// The two actions on a marshalled fit's page (docs/fitting-marshal.md):
// unmarshal — the one `.primary` on the page, since putting the fit back in a
// game client is what the page is for — and a `.danger` delete from the
// archive, the only way a marshalled fit leaves the account from the web.

type UnmarshalControlsProps = {
  contentHash: string
  fitName: string
  // The caller's characters, emptiest first; full or unwritable ones
  // disabled with the reason.
  targets: UnmarshalTarget[]
}

export const UnmarshalControls = ({ contentHash, fitName, targets }: UnmarshalControlsProps) => {
  const router = useRouter()
  const unmarshalRef = useRef<HTMLDialogElement>(null)
  const deleteRef = useRef<HTMLDialogElement>(null)
  const firstOpen = targets.find((t) => !t.disabled)
  const [target, setTarget] = useState(firstOpen?.registrationId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const unmarshal = () =>
    startTransition(async () => {
      setError(null)
      const result = await unmarshalFittingAction(contentHash, target)
      if (result.error) setError(result.error)
      else if (result.href) {
        unmarshalRef.current?.close()
        router.push(result.href)
      }
    })

  const remove = () =>
    startTransition(async () => {
      setError(null)
      const result = await deleteMarshalledAction(contentHash)
      if (result.error) setError(result.error)
      else if (result.href) {
        deleteRef.current?.close()
        router.push(result.href)
      }
    })

  return (
    <>
      <button
        type="button"
        className="primary"
        disabled={pending || firstOpen === undefined}
        onClick={() => unmarshalRef.current?.showModal()}
      >
        unmarshal
      </button>
      <button type="button" className="danger" disabled={pending} onClick={() => deleteRef.current?.showModal()}>
        delete from archive
      </button>
      {firstOpen === undefined ? (
        <p className={styles.controlsHint}>
          No character can take it: each is full, or has not granted <em>save and delete fittings</em>.
        </p>
      ) : null}
      {error ? <p className={styles.controlsError}>{error}</p> : null}

      <dialog ref={unmarshalRef} className={dialogStyles.dialog}>
        <h2>Unmarshal this fitting</h2>
        <p className={dialogStyles.hint}>
          Saves <strong>{fitName}</strong> into the game on the character you pick, using one of their 500 slots, and
          takes it out of the archive. If that character already has this exact fit saved, no slot is spent.
        </p>
        <label>
          To
          <select className={styles.targetSelect} value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t.registrationId} value={t.registrationId} disabled={t.disabled}>
                {targetLabel(t)}
              </option>
            ))}
          </select>
        </label>
        {error ? <p className={dialogStyles.error}>{error}</p> : null}
        <div className={dialogStyles.footer}>
          <button type="button" className="primary" onClick={unmarshal} disabled={pending || target === ''}>
            {pending ? 'Saving…' : 'Unmarshal'}
          </button>
          <button type="button" className="quiet" onClick={() => unmarshalRef.current?.close()} disabled={pending}>
            Cancel
          </button>
        </div>
      </dialog>

      <dialog ref={deleteRef} className={dialogStyles.dialog}>
        <h2>Delete from the archive</h2>
        <p className={dialogStyles.hint}>
          Removes <strong>{fitName}</strong> from your archive. It is not in any game client, so after this the only
          copy is the one in your write log, if it came from an EVE delete — or on your own disk, if you copied it in.
        </p>
        {error ? <p className={dialogStyles.error}>{error}</p> : null}
        <div className={dialogStyles.footer}>
          <button type="button" className="danger" onClick={remove} disabled={pending}>
            {pending ? 'Deleting…' : 'Delete'}
          </button>
          <button type="button" className="quiet" onClick={() => deleteRef.current?.close()} disabled={pending}>
            Cancel
          </button>
        </div>
      </dialog>
    </>
  )
}
