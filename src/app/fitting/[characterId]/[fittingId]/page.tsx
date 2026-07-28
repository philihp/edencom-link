import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ascend, groupBy, sortWith } from 'ramda'

import { createClient } from '@/utils/supabase/server'
import { ShipFitViewDynamic } from '../../../ship/[itemId]/shipFitViewDynamic'
import { Name } from '../../../names'
import { fetchTypeNames } from '../../../typeNames'
import { flagSortKey, groupForFlag, toEsiFit, type FittingItem, type FittingRow } from '../../fit'
import styles from '../../fittings.module.css'

// One saved fitting, rendered in the eveship.fit wheel.
//
// The route carries the owning registration's uuid as well as the fitting id
// because ESI numbers fittings per pilot (every character has a fitting 1), so
// the id alone identifies nothing. RLS still does the access control — a uuid
// belonging to another account matches no row.
const FittingDetailPage = async ({ params }: { params: Promise<{ characterId: string; fittingId: string }> }) => {
  const { characterId, fittingId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: fit } = await supabase
    .from('character_fitting')
    .select('character_id, fitting_id, name, description, ship_type_id, items')
    .eq('character_id', characterId)
    .eq('fitting_id', fittingId)
    .maybeSingle<FittingRow>()
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []

  // One bulk SDE lookup covers the hull and every fitted type.
  const [typeNames, { data: registration }] = await Promise.all([
    fetchTypeNames([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))]),
    supabase.from('registration').select('name').eq('id', characterId).maybeSingle<{ name: string }>(),
  ])
  const hull = typeNames[Number(fit.ship_type_id)] ?? `#${fit.ship_type_id}`

  // Group the module list by slot family for the text listing under the wheel:
  // readable while the viewer's WASM loads, and the only place the bays are
  // itemized. Sorted by slot order, then by the flag itself so HiSlot0 precedes
  // HiSlot1 within a group.
  const ordered = sortWith<FittingItem>(
    [ascend((i) => flagSortKey(i.flag)), ascend((i) => i.flag), ascend((i) => Number(i.type_id))],
    items
  )
  // groupBy inserts each key the first time it's seen, and the keys here are
  // non-numeric strings, so Object.entries hands them back in slot order —
  // `ordered` was already sorted that way. The filter is only to narrow away
  // groupBy's `| undefined` value type.
  const grouped = groupBy((i: FittingItem) => groupForFlag(i.flag), ordered)
  const groups = Object.entries(grouped).filter(
    (entry): entry is [string, FittingItem[]] => (entry[1]?.length ?? 0) > 0
  )

  return (
    <>
      <p className={styles.meta}>
        <Link href="/fitting">fittings</Link> / <Name name={hull} />
      </p>
      <h1 className="serif">{fit.name || `Fitting #${fit.fitting_id}`}</h1>
      <p className={styles.meta}>
        <Name name={hull} /> — saved by <Name name={registration?.name ?? null} />
      </p>
      {fit.description ? <p className={styles.description}>{fit.description}</p> : null}

      <ShipFitViewDynamic esiFit={toEsiFit(fit)} />

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
    </>
  )
}

export default FittingDetailPage
