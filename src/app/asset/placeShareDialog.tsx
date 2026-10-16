'use client'

import { useRef, useState } from 'react'

import { revokeCorpPlaceShare, saveCorpPlaceShare } from './corpShareActions'
import { grantorKey, type PlaceGrantor, placeShareSubject, placeShareTab } from './placeShare'
import { revokePlaceShare, savePlaceShare } from './shareActions'
import type { CorpShareDialogData, ShareDialogData } from './shareData'
import styles from './shareDialog.module.css'
import { ShareForm } from './shareDialog'
import { shareHint } from './shareHint'

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
        {/* Names the share the form below edits, so the active tab is never in
            doubt. */}
        <h2>Share {placeShareSubject(grantor)}</h2>
        {/* One tab per grantor, each over its own share row. A tab rather than
            a radio: choosing one switches the whole form below to that row,
            it does not set a field within it. */}
        {shares.length > 1 ? (
          <div role="tablist" aria-label="What to share" className={styles.tabList}>
            {shares.map((s, i) => (
              <button
                key={grantorKey(s.grantor)}
                type="button"
                role="tab"
                id={`place-share-tab-${grantorKey(s.grantor)}`}
                aria-selected={i === selected}
                aria-controls="place-share-panel"
                title={placeShareSubject(s.grantor)}
                className={i === selected ? `${styles.tab} ${styles.tabActive}` : styles.tab}
                onClick={() => setSelected(i)}
              >
                {placeShareTab(s.grantor)}
                {shared.has(grantorKey(s.grantor)) ? <span className={styles.tabShared}>shared</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        <div
          role={shares.length > 1 ? 'tabpanel' : undefined}
          id="place-share-panel"
          aria-labelledby={shares.length > 1 ? `place-share-tab-${key}` : undefined}
        >
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
            hint={shareHint(
              placeId,
              [placeName],
              grantor.kind === 'corporation' ? { kind: 'corporation', name: grantor.name } : { kind: 'you' }
            )}
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
        </div>
      </dialog>
    </>
  )
}
