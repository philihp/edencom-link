'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

import { WindowSelect } from '../../windowSelect'
import { rebateWindowHref } from './window'
import styles from './rebates.module.css'

const PATH = '/structure/rebates'

// The two window controls: the length (the shared dropdown) and the day the
// window starts on. An empty start day is a window trailing from now.
export const RebateWindowSelect = ({ days, from }: { days: number; from: string | null }) => {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const go = (next: { days: number; from: string | null }) =>
    startTransition(() => router.replace(rebateWindowHref(PATH, next), { scroll: false }))
  return (
    <span className={styles.windowControls} data-pending={pending || undefined}>
      <label className={styles.fromControl}>
        <span>from</span>
        <input
          type="date"
          value={from ?? ''}
          onChange={(e) => go({ days, from: e.target.value === '' ? null : e.target.value })}
        />
      </label>
      <WindowSelect days={days} pending={pending} onChange={(next) => go({ days: next, from })} />
      {from != null && (
        <button type="button" className="quiet" onClick={() => go({ days, from: null })}>
          up to now
        </button>
      )}
    </span>
  )
}
