'use client'

import Link from 'next/link'

import { ALL_OWNERS, OwnerSelect, ownerNames, useOwnerFilter, type Owners } from '../../ownerFilter'
import retro from '../../retro.module.css'
import { TypeName } from '../../typeName'
import styles from '../assets.module.css'
import { OWNER_STORAGE_KEY } from '../filterKey'
import { Quantity } from './quantity'

export type ItemRow = {
  itemId: string
  // Character registration uuid, or corporation id for corp-hangar items.
  ownerId: string
  typeId: number
  name: string | null
  quantity: number | string | null
  isSingleton: boolean | null
  flag: string | null
  contents: number
  // True for the ship this row's owner is presently piloting (docked or not).
  // ESI reports it at wherever it's docked, indistinguishable from any other
  // ship parked there, so the UI tags it instead of hiding it.
  isCurrentShip: boolean
  // Where clicking the item goes: /ship/[id] for ships, /asset/[id] for
  // containers with contents, null for plain stacks (no link). Computed
  // server-side, where the SDE category lookup lives.
  href: string | null
}

type LocationAssetsProps = {
  rows: ItemRow[]
  owners: Owners
  typeNamesPromise: Promise<Record<number, string>>
}

export const LocationAssets = ({ rows, owners, typeNamesPromise }: LocationAssetsProps) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)

  const filtered = rows.filter((r) => ownerId === ALL_OWNERS || r.ownerId === ownerId)
  const ownerMap = ownerNames(owners)

  return (
    <section>
      {rows.length > 0 ? (
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>
                <label className={styles.filter}>
                  Owner:&nbsp;
                  <OwnerSelect owners={owners} value={ownerId} onChange={setOwnerId} />
                </label>
              </th>
              <th>Item</th>
              <th className={retro.num}>Quantity</th>
              <th>Hangar</th>
              <th className={retro.num}>Contents</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={`item-${row.itemId}`}>
                <td>{ownerMap.get(row.ownerId) ?? row.ownerId}</td>
                <td>
                  {row.href ? (
                    // Ships open their own /ship page; containers drill into /asset.
                    <Link href={row.href}>
                      <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                    </Link>
                  ) : (
                    <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                  )}
                  {row.isCurrentShip && <span className={styles.badge}>current ship</span>}
                </td>
                <td className={retro.num}>{row.isSingleton ? '—' : <Quantity value={row.quantity} />}</td>
                <td>{row.flag ?? '—'}</td>
                <td className={retro.num}>{row.contents > 0 ? row.contents : '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              // Keep the table (and the owner dropdown in its header) rendered
              // so the filter can be changed back when an owner has nothing here.
              <tr>
                <td colSpan={5}>No assets here for this owner.</td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <p>No assets known at this location.</p>
      )}
    </section>
  )
}
