'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ascend, descend, sortWith } from 'ramda'

import { ALL_OWNERS, OwnerSelect, ownerNames, useOwnerFilter, type Owners } from '../../ownerFilter'
import retro from '../../retro.module.css'
import { TypeIcon } from '../../typeIcon'
import { TypeName } from '../../typeName'
import styles from '../assets.module.css'
import { OWNER_STORAGE_KEY } from '../filterKey'
import { AppraiseButton } from './appraiseButton'
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
  // False on the anonymous share-token path, which has no session to authorize
  // /api/appraisal with — the column is dropped entirely rather than rendering
  // buttons that could only ever 401.
  canAppraise: boolean
}

// The sortable columns. Appraisal is deliberately absent: its values only exist
// once each row's button has been pressed, so there'd be nothing to order by.
type SortKey = 'quantity' | 'item' | 'owner' | 'hangar' | 'contents'
type Sort = { key: SortKey; dir: 'asc' | 'desc' }

// A stack of one — what a singleton (a ship, a rig, an assembled container)
// holds — so an unlabelled quantity cell still sorts where it belongs.
const SINGLE = 1

// ESI stores the literal string "None" for a singleton with no player-assigned
// name; TypeName hides it, so sorting ignores it too.
const givenName = (row: ItemRow): string | null => (row.name && row.name !== 'None' ? row.name : null)

type SortHeaderProps = {
  label: string
  sortKey: SortKey
  sort: Sort | null
  onSort: (key: SortKey) => void
  numeric?: boolean
}

// A column header that sorts on click. Declared at module scope rather than
// inside LocationAssets: a component defined during render is a new type on
// every render, so React would remount these buttons and drop keyboard focus
// the moment one of them was used.
const SortHeader = ({ label, sortKey, sort, onSort, numeric }: SortHeaderProps) => {
  const active = sort?.key === sortKey
  return (
    <th
      className={numeric ? retro.num : undefined}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className={styles.sortButton} onClick={() => onSort(sortKey)}>
        {label}
        {/* Fixed-width so the header doesn't shift as the marker moves. */}
        <span className={styles.sortMarker} aria-hidden="true">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  )
}

export const LocationAssets = ({ rows, owners, typeNamesPromise, canAppraise }: LocationAssetsProps) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)
  const [sort, setSort] = useState<Sort | null>(null)
  // Type names stream in (the server hands us a promise so a big hangar doesn't
  // block the page), and each cell renders its own through Suspense. Sorting by
  // item needs them all at once, so they're mirrored into state as they land
  // rather than awaited here — reading the promise with use() would suspend the
  // whole table, which is exactly what the streaming avoids. Until they arrive,
  // an item sorts by whatever its cell is showing (given name, else "#id").
  const [typeNames, setTypeNames] = useState<Record<number, string>>({})
  useEffect(() => {
    let live = true
    typeNamesPromise.then((names) => {
      if (live) setTypeNames(names)
    })
    return () => {
      live = false
    }
  }, [typeNamesPromise])

  const ownerMap = ownerNames(owners)
  const filtered = rows.filter((r) => ownerId === ALL_OWNERS || r.ownerId === ownerId)

  // What each sortable column compares on — the cell's own displayed value, so
  // the order always matches what's on screen. Strings are lower-cased so a
  // capitalized name doesn't sort into its own block ahead of everything else.
  const sortValue = (row: ItemRow, key: SortKey): number | string => {
    switch (key) {
      case 'quantity':
        return row.isSingleton ? SINGLE : Number(row.quantity ?? SINGLE)
      case 'item':
        return (givenName(row) ?? typeNames[row.typeId] ?? `#${row.typeId}`).toLowerCase()
      case 'owner':
        return (ownerMap.get(row.ownerId) ?? row.ownerId).toLowerCase()
      case 'hangar':
        return (row.flag ?? '').toLowerCase()
      case 'contents':
        return row.contents
    }
  }

  // Unsorted keeps the server's order (the asset browser sends containers
  // first, then type id; the ship page sends fitting-slot order). Sorting is
  // stable, so rows that tie hold that order within their group.
  const ordered = sort
    ? sortWith<ItemRow>([(sort.dir === 'asc' ? ascend : descend)((row) => sortValue(row, sort.key))], filtered)
    : filtered

  // Same column again flips direction; a new column starts ascending.
  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current?.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    )

  return (
    <section>
      {rows.length > 0 ? (
        <>
          {/* The owner filter lives above the table rather than inside a header
              cell: the headers are sort controls now, and this stays reachable
              even when the chosen owner has nothing here. */}
          <div className={styles.filters}>
            <label className={styles.filter}>
              Owner:&nbsp;
              <OwnerSelect owners={owners} value={ownerId} onChange={setOwnerId} />
            </label>
          </div>
          <table className={retro.retro}>
            <thead>
              <tr>
                <SortHeader label="Quantity" sortKey="quantity" sort={sort} onSort={toggleSort} numeric />
                <SortHeader label="Item" sortKey="item" sort={sort} onSort={toggleSort} />
                <SortHeader label="Owner" sortKey="owner" sort={sort} onSort={toggleSort} />
                <SortHeader label="Hangar" sortKey="hangar" sort={sort} onSort={toggleSort} />
                <SortHeader label="Contents" sortKey="contents" sort={sort} onSort={toggleSort} numeric />
                {canAppraise && <th className={retro.num}>Appraisal</th>}
              </tr>
            </thead>
            <tbody>
              {ordered.map((row) => (
                <tr key={`item-${row.itemId}`}>
                  {/* A singleton has no stack size to speak of — left blank
                      rather than filled with a placeholder dash. */}
                  <td className={retro.num}>
                    {row.isSingleton || row.quantity == null ? null : <Quantity value={row.quantity} />}
                  </td>
                  <td>
                    {/* Icon first, then the name — one line, the icon never
                        wrapping away from the text it belongs to. It sits
                        outside the link so a click always lands on the name,
                        and it renders immediately (no name lookup). */}
                    <span className={styles.item}>
                      <TypeIcon id={row.typeId} />
                      {row.href ? (
                        // Ships open their own /ship page; containers drill into /asset.
                        <Link href={row.href}>
                          <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                        </Link>
                      ) : (
                        <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                      )}
                      {row.isCurrentShip && <span className={styles.badge}>current ship</span>}
                    </span>
                  </td>
                  <td>{ownerMap.get(row.ownerId) ?? row.ownerId}</td>
                  <td>{row.flag ?? '—'}</td>
                  <td className={retro.num}>{row.contents > 0 ? row.contents : '—'}</td>
                  {canAppraise && (
                    // A container or ship prices itself plus everything nested
                    // inside it; a plain stack prices just itself.
                    <td className={retro.num}>
                      <AppraiseButton target={row.itemId} />
                    </td>
                  )}
                </tr>
              ))}
              {ordered.length === 0 && (
                <tr>
                  <td colSpan={canAppraise ? 6 : 5}>No assets here for this owner.</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      ) : (
        <p>No assets known at this location.</p>
      )}
    </section>
  )
}
