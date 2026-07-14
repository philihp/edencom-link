'use client'

import { useRef, useState } from 'react'

import styles from './mercenaryDens.module.css'

// Small clipboard button next to a reinforced den's timer. Copies a
// Discord-ready ping, e.g.
//   Mercenary Den Reinforced - `JVA-FE` planet `II` at <t:1784057275:s> @ <t:1784057275:R>
// where <t:…:s> renders in Discord as the viewer's local wall-clock time and
// <t:…:R> as a live relative countdown ("in 26 hours"). Flashes a ✓ on success.
const CopyDiscordPing = ({
  system,
  planet,
  reinforcementEnd,
}: {
  system: string
  planet: string
  reinforcementEnd: string
}) => {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onClick = async () => {
    const unix = Math.floor(new Date(reinforcementEnd).getTime() / 1000)
    const text = `Mercenary Den Reinforced - \`${system}\` planet \`${planet}\` at <t:${unix}:s> @ <t:${unix}:R>`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be denied (permissions, insecure context) — this
      // is a convenience button, so fail silently rather than alerting.
    }
  }

  return (
    <button
      type="button"
      className={styles.copyButton}
      onClick={onClick}
      title="Copy Discord ping"
      aria-label="Copy Discord ping for this reinforcement timer"
    >
      {copied ? '✓' : '📋'}
    </button>
  )
}

export default CopyDiscordPing
