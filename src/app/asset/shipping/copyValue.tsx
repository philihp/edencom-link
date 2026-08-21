'use client'

// A clipboard button for one value on the shipping calculator, following the
// mercenary-dens ping button: borderless 📋 that flashes ✓, and fails silently
// because it is a convenience, not the only way to get the value (it is right
// there on screen to select by hand).
//
// The reason these exist at all is that the figures are displayed grouped
// ("264,750,000 ISK") but a courier contract's fields take bare digits, so the
// value on screen is not the value you can paste. What lands on the clipboard
// is therefore the plain number, separators and unit stripped — never what is
// rendered.
import { useRef, useState } from 'react'

import styles from './shipping.module.css'

export const CopyValue = ({ value, label }: { value: string; label: string }) => {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Denied permissions or an insecure context — say nothing rather than
      // alerting over a shortcut.
    }
  }

  return (
    <button
      type="button"
      className={styles.copyButton}
      onClick={onClick}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
    >
      {copied ? '✓' : '📋'}
    </button>
  )
}
