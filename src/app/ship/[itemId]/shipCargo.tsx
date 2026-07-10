'use client'

import Link from 'next/link'
import {
  __,
  allPass,
  always,
  ascend,
  complement,
  cond,
  equals,
  filter,
  groupBy,
  gt,
  isNil,
  lensProp,
  map,
  pipe,
  prop,
  sortBy,
  sortWith,
  T,
  toPairs,
  view,
} from 'ramda'

import { ALL_OWNERS, OwnerSelect, ownerNames, useOwnerFilter, type Owners } from '../../ownerFilter'
import { TypeName } from '../../typeName'
import styles from '../../asset/assets.module.css'
import { OWNER_STORAGE_KEY } from '../../asset/filterKey'
import { type ItemRow } from '../../asset/[locationId]/locationAssets'
import bayStyles from './shipCargo.module.css'

// Fitted-slot flags (HiSlot0, MedSlot3, RigSlot1, …) share a bay per slot
// kind, ordered by slot index within it. Every other flag ("Cargo",
// "DroneBay", "OreHold", a Rorqual's "SpecializedGasHold", …) is its own bay,
// keyed by the raw flag so unrecognized ones still get a sensible section
// instead of being dropped or lumped together.
const SLOT_KINDS = ['Hi', 'Med', 'Lo', 'Rig', 'SubSystem', 'Service']
const SLOT_LABELS: Record<string, string> = {
  Hi: 'High Power',
  Med: 'Mid Power',
  Lo: 'Low Power',
  Rig: 'Rig Slots',
  SubSystem: 'Subsystems',
  Service: 'Service Slots',
}
// Display order for the bay sections; anything not listed here (an
// unrecognized flag, or no flag at all) sorts after all of these, by label.
const BAY_ORDER = [...SLOT_KINDS, 'DroneBay', 'FighterBay', 'Cargo', 'FleetHangar', 'ShipHangar']

// "OreHold" → "Ore Hold", "SpecializedGasHold" → "Specialized Gas Hold". Falls
// back to this for any flag with no hardcoded label above.
const humanizeFlag = (flag: string) => flag.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim()

// The two hardcoded labels, then everything else humanized — a `cond` reads
// as the "match this key against a few cases" it is, point-free on the key.
const labelForKey: (key: string) => string = cond([
  [equals('Cargo'), always('Cargo Hold')],
  [equals('Other'), always('Other')],
  [T, humanizeFlag],
])

type Bay = { key: string; label: string; order: number; slotIndex: number; items: ItemRow[] }

// Lenses onto the two ItemRow fields bays care about: the flag that decides
// which bay an item belongs in, and the type id items within a bay sort by.
const flagLens = lensProp<ItemRow, 'flag'>('flag')
const typeIdLens = lensProp<ItemRow, 'typeId'>('typeId')

const bayFor = (flag: string | null): Omit<Bay, 'items'> => {
  const slotMatch = flag?.match(/^(Hi|Med|Lo|Rig|SubSystem|Service)Slot(\d+)$/)
  if (slotMatch) {
    const [, kind, index] = slotMatch
    return { key: kind, label: SLOT_LABELS[kind], order: BAY_ORDER.indexOf(kind), slotIndex: Number(index) }
  }
  const key = flag ?? 'Other'
  return {
    key,
    label: labelForKey(key),
    order: BAY_ORDER.includes(key) ? BAY_ORDER.indexOf(key) : BAY_ORDER.length,
    slotIndex: 0,
  }
}

// Group rows by bay key (read off each row through the flag lens), fold each
// group into a Bay — reusing bayFor on the group's first row for the shared
// label/order/slot metadata, sorting its items by type id through the type id
// lens — then order the bays themselves for display.
const groupIntoBays: (rows: ItemRow[]) => Bay[] = pipe(
  groupBy<ItemRow>(pipe(view(flagLens), bayFor, prop('key'))),
  toPairs,
  map(([key, items = []]: [string, ItemRow[] | undefined]) => ({
    ...bayFor(items.length > 0 ? view(flagLens, items[0]) : null),
    key,
    items: sortBy(view(typeIdLens), items),
  })),
  sortWith([ascend(prop('order')), ascend(prop('slotIndex')), ascend(prop('label'))])
)

// An item earns a quantity badge when it isn't a unique/fitted singleton, its
// quantity is known, and its stack is more than one.
const hasVisibleQuantity: (item: ItemRow) => boolean = allPass([
  complement(prop('isSingleton')),
  pipe(prop('quantity'), complement(isNil)),
  pipe(prop('quantity'), Number, gt(__, 1)),
])

type ShipCargoProps = {
  rows: ItemRow[]
  owners: Owners
  typeNamesPromise: Promise<Record<number, string>>
}

// Item icons/quantity tiles grouped by hold/slot, echoing the EVE client's
// fitting-and-cargo layout — the bays a ship actually has (only sections with
// at least one item render) rather than a blank slot-by-slot mockup.
export const ShipCargo = ({ rows, owners, typeNamesPromise }: ShipCargoProps) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)

  const filtered = filter((r: ItemRow) => equals(ownerId, ALL_OWNERS) || equals(r.ownerId, ownerId), rows)
  const ownerMap = ownerNames(owners)
  const bays = groupIntoBays(filtered)

  return (
    <section>
      <label className={styles.filter}>
        Owner:&nbsp;
        <OwnerSelect owners={owners} value={ownerId} onChange={setOwnerId} />
      </label>

      {bays.length > 0 ? (
        map(
          (bay: Bay) => (
            <div key={bay.key} className={bayStyles.bay}>
              <h3 className={bayStyles.bayLabel}>{bay.label}</h3>
              <ul className={bayStyles.grid}>
                {map((item: ItemRow) => {
                  const tile = (
                    <>
                      <img
                        className={bayStyles.icon}
                        src={`https://images.evetech.net/types/${item.typeId}/icon?size=64`}
                        alt=""
                        width={48}
                        height={48}
                      />
                      {hasVisibleQuantity(item) && (
                        <span className={bayStyles.qty}>{Number(item.quantity).toLocaleString('en-US')}</span>
                      )}
                      <span className={bayStyles.name}>
                        <TypeName id={item.typeId} name={item.name} promise={typeNamesPromise} />
                      </span>
                      {equals(ownerId, ALL_OWNERS) && (
                        <span className={bayStyles.owner}>{ownerMap.get(item.ownerId) ?? item.ownerId}</span>
                      )}
                    </>
                  )
                  return (
                    <li key={`item-${item.itemId}`} className={bayStyles.tile}>
                      {item.href ? (
                        <Link href={item.href} className={bayStyles.tileLink}>
                          {tile}
                        </Link>
                      ) : (
                        tile
                      )}
                    </li>
                  )
                }, bay.items)}
              </ul>
            </div>
          ),
          bays
        )
      ) : (
        <p>Nothing in this ship for this owner.</p>
      )}
    </section>
  )
}
