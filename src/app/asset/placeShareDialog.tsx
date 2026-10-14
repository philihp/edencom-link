'use client'

import { useRef, useState } from 'react'

import { revokeCorpPlaceShare, saveCorpPlaceShare } from './corpShareActions'
import { grantorKey, type PlaceGrantor, placeShareHint, placeShareSubject } from './placeShare'
import { revokePlaceShare, savePlaceShare } from './shareActions'
import type { CorpShareDialogData, ShareDialogData } from './shareData'
import styles from './shareDialog.module.css'
import { ShareForm } from './shareDialog'

// The one Share button for a place — a station, structure or system
// (docs/sharing-layer/15-place-share.md). A place share is either a character
// share (everything the account's characters own there) or a corporation's;
// the dialog asks which only when the caller holds items here as more than one
// of those, and otherwise assumes the only one that has something.
export type PlaceShare = { grantor: PlaceGrantor; data: ShareDialogData | CorpShareDialogData }

export const PlaceShareDialog = ({
  placeId,
  placeName,
  shares,
}: {
  placeId: string
  placeName: string
  shares: PlaceShare[]
}) => {
  const ref = useRef<HTMLDialogElement>(null)
  const [selected, setSelected] = useState(0)
  const [shared, setShared] = useState(
    () => new Set(shares.filter((s) => s.data.share != null).map((s) => grantorKey(s.grantor)))
  )
  const current = shares[selected]
  if (!current) return null
  const { grantor, data } = current
  const key = grantorKey(grantor)

  return (
    <>
      <button type="button" onClick={() => ref.current?.showModal()}>
        Share{shared.size > 0 ? 'd' : ''}
      </button>
      <dialog ref={ref} className={styles.dialog}>
        <h2>Share {shares.length > 1 ? 'items here' : placeShareSubject(grantor)}</h2>
        {shares.length > 1 ? (
          <fieldset className={styles.audience}>
            <legend>What to share</legend>
            {shares.map((s, i) => (
              <label key={grantorKey(s.grantor)}>
                <input type="radio" name="place-share-kind" checked={i === selected} onChange={() => setSelected(i)} />
                {placeShareSubject(s.grantor)}
              </label>
            ))}
          </fieldset>
        ) : null}
        <ShareForm
          key={key}
          urlPath={`/asset/${placeId}`}
          data={data}
          save={
            grantor.kind === 'corporation'
              ? saveCorpPlaceShare.bind(null, grantor.corporationId, placeId)
              : savePlaceShare.bind(null, placeId)
          }
          revoke={
            grantor.kind === 'corporation'
              ? revokeCorpPlaceShare.bind(null, grantor.corporationId, placeId)
              : revokePlaceShare.bind(null, placeId)
          }
          hint={placeShareHint(grantor, placeName)}
          onShareChange={(share) =>
            setShared((prev) => {
              const next = new Set(prev)
              if (share) next.add(key)
              else next.delete(key)
              return next
            })
          }
          onClose={() => ref.current?.close()}
        />
      </dialog>
    </>
  )
}
