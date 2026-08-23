// The industry job-slot bubbles on a character tile: one row per slot family,
// one bubble per slot, filled for a running job and "ready" for one waiting to
// be delivered. Split out of the /character page so /registration can render
// the identical bubbles (docs/registrations-page/01-shared-data-seams.md).
// Named for the bubbles rather than the slots so it doesn't read as a second
// src/app/industry/jobSlots.ts, which is where the arithmetic lives.
import { range } from 'ramda'

import { type SlotCounts, type SlotFamily, type SlotMax } from '../industry/jobSlots'
import styles from './character.module.css'

const SLOT_ROWS: { family: SlotFamily; label: string }[] = [
  { family: 'manufacturing', label: 'Manufacturing' },
  { family: 'research', label: 'Research' },
  { family: 'reaction', label: 'Reactions' },
]

export const JobSlots = ({ counts, max }: { counts: SlotCounts; max: SlotMax }) => (
  <div className={styles.slots}>
    {SLOT_ROWS.map(({ family, label }) => {
      const { running, finished } = counts[family]
      // Never hide a job: if skill data lags behind reality, widen the row to
      // fit every occupied slot rather than clip it.
      const slotCount = Math.max(max[family], running + finished)
      return (
        <div
          key={family}
          className={`${styles.slotRow} ${styles[family]}`}
          title={`${label}: ${running} running, ${finished} ready of ${max[family]} slot${max[family] === 1 ? '' : 's'}`}
        >
          {range(0, slotCount).map((i) => {
            if (i < running) return <span key={i} className={`${styles.slot} ${styles.slotFilled}`} />
            if (i < running + finished) return <span key={i} className={`${styles.slot} ${styles.slotReady}`} />
            return <span key={i} className={styles.slot} />
          })}
        </div>
      )
    })}
  </div>
)
