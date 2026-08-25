'use client'

import { useRef, useState } from 'react'

import styles from './fittings.module.css'

// The EFT block at the foot of a fitting page. Click it and the whole export
// lands on the clipboard, ready for the in-game fitting window's "Import from
// clipboard" — the textarea is read-only and selects itself so a click is the
// whole interaction, and a manual ⌘A/⌘C still works if the clipboard API is
// denied (insecure context, permission refused).
export const EftExport = ({ eft }: { eft: string }) => {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flash = () => {
    setCopied(true)
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  const onClick = async (event: React.MouseEvent<HTMLTextAreaElement>) => {
    event.currentTarget.select()
    try {
      await navigator.clipboard.writeText(eft)
      flash()
    } catch {
      // Selection is already made, so the fallback is a manual copy — nothing
      // to alert about.
    }
  }

  return (
    <div className={styles.eftExport}>
      <div className={styles.eftHeader}>
        <span className={styles.slotLabel}>EFT export</span>
        <span className={styles.eftHint} aria-live="polite">
          {copied ? 'Copied' : 'Click to copy'}
        </span>
      </div>
      <textarea
        className={styles.eftText}
        value={eft}
        readOnly
        spellCheck={false}
        rows={Math.min(eft.split('\n').length + 1, 30)}
        onClick={onClick}
        onFocus={(event) => event.currentTarget.select()}
        aria-label="Fitting in EFT format — click to copy"
      />
    </div>
  )
}
