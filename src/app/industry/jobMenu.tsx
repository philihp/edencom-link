'use client'

import { useEffect, useId, useRef, useState, useTransition, type ToggleEvent } from 'react'

import { setJobHidden, type JobOwner } from './hiddenActions'
import styles from './industry.module.css'

// The ellipsis at the right end of one of the caller's own job rows
// (docs/sharing-layer/16-industry-job-share.md, PR 1): a popover menu with one
// item, hiding the job from co-tenants or making it visible again. The menu is
// a native `popover` — top layer, so the table's horizontal scroll does not
// clip it, with light dismiss and Escape for free — placed under the button
// when it opens. A hidden row carries a gray `hidden` readout beside the
// button so the owner sees the state at a glance.

const DESCRIPTION =
  "Jobs are visible to all other users who have run a job in that structure within 30 days of that job, because both of you are affecting each other's cost indexes. A hidden job is seen only by you — not by co-tenants, and not through any share."

type JobMenuProps = {
  jobId: string
  owner: JobOwner
  hidden: boolean
}

export const JobMenu = ({ jobId, owner, hidden }: JobMenuProps) => {
  const menuId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // The menu is fixed to where the button was; a scroll would leave it
  // floating over the wrong row, so any scroll closes it.
  useEffect(() => {
    if (!open) return
    const close = () => menuRef.current?.hidePopover()
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // The button is the popover's invoker (popoverTarget), so the browser
  // toggles it and keeps the click on the button out of light dismiss; this
  // only places the menu under the button as it opens — or above it, once it
  // is open and measurable, when there is no room below.
  const place = (e: ToggleEvent<HTMLDivElement>) => {
    const button = buttonRef.current
    if (e.newState !== 'open' || !button) return
    const r = button.getBoundingClientRect()
    e.currentTarget.style.top = `${r.bottom + 4}px`
    e.currentTarget.style.right = `${document.documentElement.clientWidth - r.right}px`
    setError(null)
  }
  const toggled = (e: ToggleEvent<HTMLDivElement>) => {
    const isOpen = e.newState === 'open'
    setOpen(isOpen)
    const button = buttonRef.current
    if (!isOpen || !button) return
    const r = button.getBoundingClientRect()
    const height = e.currentTarget.offsetHeight
    if (r.bottom + 4 + height > window.innerHeight && r.top - 4 - height >= 0)
      e.currentTarget.style.top = `${r.top - 4 - height}px`
  }

  const choose = () =>
    startTransition(async () => {
      const result = await setJobHidden(jobId, owner, !hidden)
      if (result.ok) menuRef.current?.hidePopover()
      else setError(result.error)
    })

  return (
    <span className={styles.jobOptions}>
      {hidden && <span className={styles.hiddenTag}>hidden</span>}
      <button
        type="button"
        className={`quiet ${styles.ellipsis}`}
        aria-label="Job options"
        aria-haspopup="menu"
        aria-expanded={open}
        ref={buttonRef}
        popoverTarget={menuId}
      >
        …
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        role="menu"
        className={styles.jobMenu}
        onBeforeToggle={place}
        onToggle={toggled}
      >
        <div className={styles.jobMenuItem}>
          <button type="button" role="menuitem" onClick={choose} disabled={pending}>
            {pending ? 'Saving…' : hidden ? 'Make this job Visible' : 'Make this job Hidden'}
          </button>
          <p className={styles.jobMenuText}>{DESCRIPTION}</p>
        </div>
        {error && (
          <p className={styles.jobMenuError} role="alert">
            {error}
          </p>
        )}
      </div>
    </span>
  )
}
