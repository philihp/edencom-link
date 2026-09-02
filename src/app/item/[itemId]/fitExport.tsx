'use client'

import { useRef, useState } from 'react'

import styles from './fitExport.module.css'

// The "Export fit" action on the identity strip: a native <dialog> holding the
// ship as EFT text (src/app/item/[itemId]/eft.ts), with a button that puts it
// on the clipboard ready for the in-game fitting window's "Import from
// clipboard". The text stays visible and selectable in a read-only textarea,
// so when the clipboard API is refused (insecure context, permission denied)
// a manual select-and-copy still works — the button selects the text for
// exactly that case rather than raising an alert over a shortcut.
export const FitExport = ({ eft }: { eft: string }) => {
  const dialog = useRef<HTMLDialogElement>(null)
  const text = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(eft)
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      text.current?.select()
    }
  }

  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()}>
        Export fit
      </button>
      <dialog ref={dialog} className={styles.dialog} onClose={() => setCopied(false)}>
        <h2>Fitting text</h2>
        <p className={styles.hint}>
          Copy this, then use <em>Import from clipboard</em> in the in-game fitting window to save it as a fit.
        </p>
        <textarea
          ref={text}
          className={styles.text}
          value={eft}
          readOnly
          spellCheck={false}
          rows={Math.min(eft.split('\n').length + 1, 30)}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="Fitting in EFT format"
        />
        <div className={styles.footer}>
          <button type="button" className="primary" onClick={copy}>
            {copied ? 'Copied' : 'Copy to clipboard'}
          </button>
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
      </dialog>
    </>
  )
}
