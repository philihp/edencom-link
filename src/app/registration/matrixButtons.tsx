'use client'

// The matrix's interactive pieces: the ↻ buttons at the design's four
// granularities (cell / column / row / everything), the failed cell's retry
// link, and the template row's checkboxes. Each wraps a server action in a
// transition and then router.refresh()es, the same shape as /jobs's
// refreshButton.tsx — the re-rendered page has a pending refresh_task for the
// cell and the poller takes over until it settles.
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { refreshAllCharacters, refreshCell } from '../jobs/actions'
import { refreshCharacter, refreshEverything, setTemplateScopes } from './actions'
import type { TemplateCheck } from './matrix'
import styles from './registration.module.css'

// One ↻ glyph button. Every trigger on the page is this, differing only in the
// action behind it and the title explaining its blast radius.
const Kick = ({ act, title, className }: { act: () => Promise<void>; title: string; className?: string }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      className={className ?? styles.kick}
      title={title}
      aria-label={title}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await act()
          router.refresh()
        })
      }
    >
      ↻
    </button>
  )
}

// One cell: one job for one character (or one corporation, via its
// representative registration).
export const CellKick = ({ job, characterId, title }: { job: string; characterId: string; title: string }) => (
  <Kick act={() => refreshCell(job, characterId)} title={title} />
)

// Column header: this job for every character that has it.
export const ColumnKick = ({ job, label }: { job: string; label: string }) => (
  <Kick act={() => refreshAllCharacters(job)} title={`Refresh ${label} for every character`} />
)

// Row tail: every job for this character.
export const RowKick = ({ characterId, name }: { characterId: string; name: string }) => (
  <Kick act={() => refreshCharacter(characterId)} title={`Refresh every job for ${name}`} className={styles.rowKick} />
)

// Page header: everything. A real button with a label, not a glyph.
export const RefreshAll = () => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await refreshEverything()
          router.refresh()
        })
      }
    >
      {pending ? 'refreshing…' : '↻ Refresh all'}
    </button>
  )
}

// A shared-universe kick, Chancellor-gated server-side (jobs/actions.ts
// re-checks; this only renders where the page already knows it may).
export const UniverseKick = ({ job, label }: { job: string; label: string }) => (
  <Kick act={() => refreshCell(job, null)} title={`Refresh ${label} for every account`} />
)

// A failed cell's retry link — the same dispatch as the cell ↻, worded as the
// design words it.
export const Retry = ({ job, characterId }: { job: string; characterId: string }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      className={styles.retry}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await refreshCell(job, characterId)
          router.refresh()
        })
      }
    >
      {pending ? 'retrying…' : 'retry'}
    </button>
  )
}

// One template-row checkbox: whether the next SSO request asks for this
// column's scopes. A mixed column (some of character-status's six scopes)
// completes to the full set on first click rather than clearing it.
export const TemplateToggle = ({
  scopes,
  check,
  label,
}: {
  scopes: readonly string[]
  check: TemplateCheck
  label: string
}) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const on = check !== 'none'
  const next = check !== 'all'
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={check === 'all' ? true : check === 'none' ? false : 'mixed'}
      className={styles.templateBox}
      data-check={check}
      title={`${on ? (check === 'all' ? 'Requested' : 'Partly requested') : 'Not requested'} — the next character you register ${on ? 'will' : 'will not'} be asked for ${label}`}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await setTemplateScopes([...scopes], next)
          router.refresh()
        })
      }
    >
      {check === 'all' ? '✓' : check === 'some' ? '~' : ''}
    </button>
  )
}
