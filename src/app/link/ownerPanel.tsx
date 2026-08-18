'use client'

import { useState, type ReactNode } from 'react'

import { LinkEditor } from './linkEditor'
import styles from './link.module.css'

type LinkOwnerPanelProps = {
  link: { id: string; name: string; query: string; variables: string }
  // The heading's other controls (CSV, Share), server-rendered and passed
  // through so they sit in the same corner row as the Edit toggle.
  children: ReactNode
}

// The owner's controls for one Link, on the Link's own page. The Edit toggle
// belongs in the heading's button row next to CSV and Share, but the form it
// opens is a column that would be crushed inside that row — so this holds the
// open state, keeps the toggle up in the corner, and renders the editor
// underneath the heading.
export const LinkOwnerPanel = ({ link, children }: LinkOwnerPanelProps) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className={styles.buttons}>
        {children}
        <button type="button" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Edit'}
        </button>
      </div>
      {open && <LinkEditor link={link} open onOpenChange={setOpen} />}
    </>
  )
}
