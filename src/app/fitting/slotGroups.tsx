import { ascend, groupBy, sortWith } from 'ramda'

import { flagSortKey, groupForFlag, type FittingItem } from './fit'
import styles from './fittings.module.css'

// The text module list under a fitting wheel, grouped by slot family the way
// the fitting window shows it: readable while the viewer's WASM loads, and the
// only place the drone/fighter/cargo bays are itemized. Shared by the personal
// and corp/alliance fit detail pages so the two can't drift.
export const SlotGroups = ({ items, typeNames }: { items: FittingItem[]; typeNames: Record<number, string> }) => {
  // Slot order, then the flag itself so HiSlot0 precedes HiSlot1 within a group.
  const ordered = sortWith<FittingItem>(
    [ascend((i) => flagSortKey(i.flag)), ascend((i) => i.flag), ascend((i) => Number(i.type_id))],
    items
  )
  // groupBy inserts each key the first time it's seen, and the keys are
  // non-numeric strings, so Object.entries hands them back in slot order. The
  // filter only narrows away groupBy's `| undefined` value type.
  const grouped = groupBy((i: FittingItem) => groupForFlag(i.flag), ordered)
  const groups = Object.entries(grouped).filter(
    (entry): entry is [string, FittingItem[]] => (entry[1]?.length ?? 0) > 0
  )

  return (
    <ul className={styles.slots}>
      {groups.map(([label, groupItems]) => (
        <li key={label} className={styles.slotGroup}>
          <span className={styles.slotLabel}>{label}</span>
          <ul className={styles.slotItems}>
            {groupItems.map((item, index) => (
              <li key={`${item.flag}:${item.type_id}:${index}`} className={styles.slotItem}>
                <span className={styles.slotItemName}>{typeNames[Number(item.type_id)] ?? `#${item.type_id}`}</span>
                {item.quantity > 1 ? <span className={styles.slotItemQuantity}>×{item.quantity}</span> : null}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}
