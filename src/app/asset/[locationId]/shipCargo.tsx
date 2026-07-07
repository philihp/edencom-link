'use client'

import Link from 'next/link'

import { ALL_OWNERS, OwnerSelect, ownerNames, useOwnerFilter, type Owners } from '../../ownerFilter'
import { TypeName } from '../../typeName'
import styles from '../assets.module.css'
import { OWNER_STORAGE_KEY } from '../filterKey'
import { type ItemRow } from './locationAssets'
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

type Bay = { key: string; label: string; order: number; slotIndex: number; items: ItemRow[] }

const bayFor = (flag: string | null): Omit<Bay, 'items'> => {
  const slotMatch = flag?.match(/^(Hi|Med|Lo|Rig|SubSystem|Service)Slot(\d+)$/)
  if (slotMatch) {
    const [, kind, index] = slotMatch
    return { key: kind, label: SLOT_LABELS[kind], order: BAY_ORDER.indexOf(kind), slotIndex: Number(index) }
  }
  const key = flag ?? 'Other'
  return {
    key,
    label: key === 'Cargo' ? 'Cargo Hold' : key === 'Other' ? 'Other' : humanizeFlag(key),
    order: BAY_ORDER.includes(key) ? BAY_ORDER.indexOf(key) : BAY_ORDER.length,
    slotIndex: 0,
  }
}

const groupIntoBays = (rows: ItemRow[]): Bay[] => {
  const bays = new Map<string, Bay>()
  for (const row of rows) {
    const meta = bayFor(row.flag)
    const bay = bays.get(meta.key) ?? { ...meta, items: [] }
    bay.items.push(row)
    bays.set(meta.key, bay)
  }
  return [...bays.values()]
    .map((bay) => ({ ...bay, items: bay.items.sort((a, b) => a.typeId - b.typeId) }))
    .sort((a, b) => a.order - b.order || a.slotIndex - b.slotIndex || a.label.localeCompare(b.label))
}

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

  const filtered = rows.filter((r) => ownerId === ALL_OWNERS || r.ownerId === ownerId)
  const ownerMap = ownerNames(owners)
  const bays = groupIntoBays(filtered)

  return (
    <section>
      <label className={styles.filter}>
        Owner:&nbsp;
        <OwnerSelect owners={owners} value={ownerId} onChange={setOwnerId} />
      </label>

      {bays.length > 0 ? (
        bays.map((bay) => (
          <div key={bay.key} className={bayStyles.bay}>
            <h3 className={bayStyles.bayLabel}>{bay.label}</h3>
            <ul className={bayStyles.grid}>
              {bay.items.map((item) => {
                const tile = (
                  <>
                    <img
                      className={bayStyles.icon}
                      src={`https://images.evetech.net/types/${item.typeId}/icon?size=64`}
                      alt=""
                      width={48}
                      height={48}
                    />
                    {!item.isSingleton && item.quantity != null && Number(item.quantity) > 1 && (
                      <span className={bayStyles.qty}>{Number(item.quantity).toLocaleString('en-US')}</span>
                    )}
                    <span className={bayStyles.name}>
                      <TypeName id={item.typeId} name={item.name} promise={typeNamesPromise} />
                    </span>
                    {ownerId === ALL_OWNERS && (
                      <span className={bayStyles.owner}>{ownerMap.get(item.ownerId) ?? item.ownerId}</span>
                    )}
                  </>
                )
                return (
                  <li key={`item-${item.itemId}`} className={bayStyles.tile}>
                    {item.contents > 0 ? (
                      <Link href={`/asset/${item.itemId}`} className={bayStyles.tileLink}>
                        {tile}
                      </Link>
                    ) : (
                      tile
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ))
      ) : (
        <p>Nothing in this ship for this owner.</p>
      )}
    </section>
  )
}
