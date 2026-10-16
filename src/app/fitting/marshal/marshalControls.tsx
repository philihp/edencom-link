'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'

import { marshalFittingAction, transferFittingAction } from '../marshalActions'
import { targetLabel, type UnmarshalTarget } from './slots'
import dialogStyles from '../../asset/shareDialog.module.css'
import styles from '../fittings.module.css'

// Marshal and Transfer on an own fit's page (docs/fitting-marshal.md), beside
// the Share dialog and in its idiom: outline buttons, a native <dialog> each,
// a bound server action under useTransition. Neither is `.primary` — the
// page's primary thing is the viewer.
//
// Both buttons delete the fit from a game client, so each waits on a confirm
// that says so in words, and both are disabled (with the reason and where to
// fix it) when the character has not granted the opt-in write scope. The
// server refuses as well; the disabled state only saves a round trip.

type MarshalControlsProps = {
  registrationId: string
  fittingId: string
  fitName: string
  pilotName: string
  // This character holds esi-fittings.write_fittings.v1.
  writable: boolean
  // A share row exists; the confirm says it will end.
  shared: boolean
  // The caller's other characters, for the transfer picker (the source is
  // already left out, emptiest first).
  targets: UnmarshalTarget[]
}

export const MarshalControls = ({
  registrationId,
  fittingId,
  fitName,
  pilotName,
  writable,
  shared,
  targets,
}: MarshalControlsProps) => {
  const router = useRouter()
  const marshalRef = useRef<HTMLDialogElement>(null)
  const transferRef = useRef<HTMLDialogElement>(null)
  const firstOpen = targets.find((t) => !t.disabled)
  const [target, setTarget] = useState(firstOpen?.registrationId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const marshal = () =>
    startTransition(async () => {
      setError(null)
      const result = await marshalFittingAction(registrationId, fittingId)
      if (result.error) setError(result.error)
      else if (result.href) {
        marshalRef.current?.close()
        router.push(result.href)
      }
    })

  const transfer = () =>
    startTransition(async () => {
      setError(null)
      const result = await transferFittingAction(registrationId, target, fittingId)
      if (!result.error && result.href) {
        transferRef.current?.close()
        router.push(result.href)
        return
      }
      // A half-done transfer carries both: the fit is on both characters.
      setError(result.href ? `${result.error} The copy is at ${result.href}.` : (result.error ?? 'Transfer failed'))
      router.refresh()
    })

  const endsShare = shared ? ' Any share of it ends.' : ''

  return (
    <>
      <button type="button" disabled={!writable || pending} onClick={() => marshalRef.current?.showModal()}>
        marshal
      </button>
      <button
        type="button"
        disabled={!writable || pending || targets.length === 0}
        onClick={() => transferRef.current?.showModal()}
      >
        transfer
      </button>
      {writable ? null : (
        <p className={styles.controlsHint}>
          {pilotName} has not granted <em>save and delete fittings</em>. Turn it on under{' '}
          <Link href="/settings/grants">grants</Link>, then re-auth the character on{' '}
          <Link href="/account/registrations">registrations</Link>.
        </p>
      )}
      {error ? <p className={styles.controlsError}>{error}</p> : null}

      <dialog ref={marshalRef} className={dialogStyles.dialog}>
        <h2>Marshal this fitting</h2>
        <p className={dialogStyles.hint}>
          Removes <strong>{fitName}</strong> from {pilotName}&rsquo;s saved fittings in EVE, freeing one of their 500
          slots. The fit stays here, and can be unmarshalled onto any of your characters later.{endsShare}
        </p>
        {error ? <p className={dialogStyles.error}>{error}</p> : null}
        <div className={dialogStyles.footer}>
          <button type="button" onClick={marshal} disabled={pending}>
            {pending ? 'Marshalling…' : 'Marshal'}
          </button>
          <button type="button" className="quiet" onClick={() => marshalRef.current?.close()} disabled={pending}>
            Cancel
          </button>
        </div>
      </dialog>

      <dialog ref={transferRef} className={dialogStyles.dialog}>
        <h2>Transfer this fitting</h2>
        <p className={dialogStyles.hint}>
          Saves <strong>{fitName}</strong> on the character you pick, then removes it from {pilotName}. The copy is made
          first, so a failure can never lose the fit.{endsShare}
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
          <button type="button" onClick={transfer} disabled={pending || target === ''}>
            {pending ? 'Transferring…' : 'Transfer'}
          </button>
          <button type="button" className="quiet" onClick={() => transferRef.current?.close()} disabled={pending}>
            Cancel
          </button>
        </div>
      </dialog>
    </>
  )
}
