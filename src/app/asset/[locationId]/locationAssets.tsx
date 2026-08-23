'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ascend, descend, difference, sortWith, union } from 'ramda'

import { LinkSpinner } from '../../linkSpinner'
import { ALL_OWNERS, OwnerSelect, ownerNames, useOwnerFilter, type Owners } from '../../ownerFilter'
import retro from '../../retro.module.css'
import { type IconVariation } from '../../iconVariation'
import { TypeIcon } from '../../typeIcon'
import { TypeName } from '../../typeName'
import styles from '../assets.module.css'
import { OWNER_STORAGE_KEY } from '../filterKey'
import { AppraisalPanel } from './appraisalPanel'
import { Quantity } from './quantity'
import { applyMarquee, boxBetween, isDrag, type Box } from './selectionMarquee'

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
  // SDE facts about this row's type, resolved server-side for the same reason
  // (the browser has no SDE access): m³ per unit — the assembled figure for a
  // ship or other singleton, which is all the SDE carries — plus the group and
  // category the type belongs to. Null for a type the published-type view
  // doesn't cover.
  unitVolume: number | null
  groupName: string | null
  categoryName: string | null
  // Which image CCP holds for this type; blueprints have no "icon" variation.
  icon: IconVariation
}

type LocationAssetsProps = {
  rows: ItemRow[]
  owners: Owners
  typeNamesPromise: Promise<Record<number, string>>
  // False on the anonymous share-token path, which has no session to authorize
  // /api/appraisal with — selection is dropped along with it rather than
  // offering checkboxes whose only action could ever 401.
  canAppraise: boolean
}

// The sortable columns. Neither the checkbox nor the appraisal figures are
// sortable: one is a control, the other exists only after it's been pressed.
type SortKey = 'quantity' | 'item' | 'volume' | 'group' | 'category' | 'owner' | 'hangar' | 'contents'
type Sort = { key: SortKey; dir: 'asc' | 'desc' }

// A stack of one — what a singleton (a ship, a rig, an assembled container)
// holds — so an unlabelled quantity cell still sorts where it belongs.
const SINGLE = 1

// ESI stores the literal string "None" for a singleton with no player-assigned
// name; TypeName hides it, so sorting ignores it too.
const givenName = (row: ItemRow): string | null => (row.name && row.name !== 'None' ? row.name : null)

const stackSize = (row: ItemRow): number => (row.isSingleton ? SINGLE : Number(row.quantity ?? SINGLE))

// What the whole stack occupies: the type's per-unit m³ times how many are in
// it. Null for a type with no volume in the SDE mirror, which renders blank
// rather than an invented zero.
const stackVolume = (row: ItemRow): number | null => (row.unitVolume == null ? null : row.unitVolume * stackSize(row))

// Volumes span from 0.01 m³ (a piece of ammo) to eight figures (a freighter's
// worth of ore), so they're grouped and capped at two decimals rather than
// printed raw.
const formatVolume = (m3: number): string => m3.toLocaleString('en-US', { maximumFractionDigits: 2 })

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

// Where a drag began, and what it's adding to: the selection as it stood when
// the button went down (shift-dragging extends that), since the live preview
// overwrites the current selection on every mouse move.
type DragStart = { from: { x: number; y: number }; base: string[]; additive: boolean }

export const LocationAssets = ({ rows, owners, typeNamesPromise, canAppraise }: LocationAssetsProps) => {
  const [ownerId, setOwnerId] = useOwnerFilter(OWNER_STORAGE_KEY, owners)
  const [sort, setSort] = useState<Sort | null>(null)
  // Selected item ids, in an array rather than a Set: ramda's set operations
  // work on it directly, and a table this size never makes the linear lookups
  // matter.
  const [selected, setSelected] = useState<string[]>([])
  // Split deliberately: `dragging` is the subscription switch (it flips twice
  // per gesture, so the window listeners aren't torn down on every mouse move),
  // `marquee` is what gets drawn, and the start of the drag lives in a ref
  // because the listeners close over it without needing to be re-bound.
  const [dragging, setDragging] = useState(false)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const dragRef = useRef<DragStart | null>(null)
  const bodyRef = useRef<HTMLTableSectionElement | null>(null)
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
        return stackSize(row)
      case 'item':
        return (givenName(row) ?? typeNames[row.typeId] ?? `#${row.typeId}`).toLowerCase()
      case 'volume':
        // An unknown volume sorts as nothing rather than jumping to the top.
        return stackVolume(row) ?? 0
      case 'group':
        return (row.groupName ?? '').toLowerCase()
      case 'category':
        return (row.categoryName ?? '').toLowerCase()
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

  // Selection only ever means the rows on screen: the owner filter can hide a
  // checked row, and appraising something the user can't see would be a
  // surprise. Kept in state rather than pruned, so unhiding restores it.
  const visibleIds = ordered.map((row) => row.itemId)
  const selectedVisible = visibleIds.filter((id) => selected.includes(id))
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length

  const toggleRow = (itemId: string, checked: boolean) =>
    setSelected((current) => (checked ? union(current, [itemId]) : difference(current, [itemId])))
  const toggleAll = () =>
    setSelected((current) => (allSelected ? difference(current, visibleIds) : union(current, visibleIds)))

  // Where each row sits right now, straight from layout — the marquee hit test
  // is against what's on screen, and the browser is the only thing that knows
  // that (rows wrap, columns resize, the page scrolls).
  const rowBoxes = useCallback(
    (): Array<{ itemId: string; box: Box }> =>
      [...(bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-item-id]') ?? [])].map((tr) => {
        const rect = tr.getBoundingClientRect()
        return {
          itemId: tr.dataset.itemId ?? '',
          box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        }
      }),
    []
  )

  // A drag is tracked on the window, not the table: the pointer routinely
  // leaves the rows mid-sweep (and mouseup can land anywhere), and a gesture
  // that only worked while staying inside the element would feel broken.
  useEffect(() => {
    if (!dragging) return
    const move = (event: MouseEvent) => {
      const start = dragRef.current
      if (!start) return
      const box = boxBetween(start.from, { x: event.clientX, y: event.clientY })
      setMarquee(box)
      // Live, so the rectangle and the checkboxes agree while it's being drawn.
      if (isDrag(box)) setSelected(applyMarquee(box, rowBoxes(), start.base, start.additive))
    }
    const end = () => {
      setDragging(false)
      setMarquee(null)
      dragRef.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
    }
  }, [dragging, rowBoxes])

  const startMarquee = (event: React.MouseEvent<HTMLTableSectionElement>) => {
    // Left button only, and never over something already clickable — a link, a
    // checkbox and a sort header all mean what they say.
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('a, button, input, label, select')) return
    dragRef.current = {
      from: { x: event.clientX, y: event.clientY },
      // Shift adds to what's already selected; a plain drag replaces it. The
      // base is frozen here because the live preview overwrites the selection
      // on every mouse move.
      base: event.shiftKey ? selected : [],
      additive: event.shiftKey,
    }
    setDragging(true)
    setMarquee(null)
    // Otherwise the browser starts selecting the table's text instead.
    event.preventDefault()
  }

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
                {canAppraise && (
                  <th className={styles.checkCell}>
                    <label className={styles.checkSlop}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        // Some but not all: neither box nor blank says that.
                        ref={(el) => {
                          if (el) el.indeterminate = selectedVisible.length > 0 && !allSelected
                        }}
                        onChange={toggleAll}
                        aria-label={allSelected ? 'Clear selection' : 'Select every row'}
                      />
                    </label>
                  </th>
                )}
                <SortHeader label="Quantity" sortKey="quantity" sort={sort} onSort={toggleSort} numeric />
                <SortHeader label="Item" sortKey="item" sort={sort} onSort={toggleSort} />
                <SortHeader label="Volume (m³)" sortKey="volume" sort={sort} onSort={toggleSort} numeric />
                <SortHeader label="Group" sortKey="group" sort={sort} onSort={toggleSort} />
                <SortHeader label="Category" sortKey="category" sort={sort} onSort={toggleSort} />
                <SortHeader label="Owner" sortKey="owner" sort={sort} onSort={toggleSort} />
                <SortHeader label="Hangar" sortKey="hangar" sort={sort} onSort={toggleSort} />
                <SortHeader label="Contents" sortKey="contents" sort={sort} onSort={toggleSort} numeric />
              </tr>
            </thead>
            <tbody
              ref={bodyRef}
              // Only the owner's own view can act on a selection, so only it
              // arms the rectangle.
              onMouseDown={canAppraise ? startMarquee : undefined}
              className={dragging ? styles.dragging : undefined}
            >
              {ordered.map((row) => (
                <tr
                  key={`item-${row.itemId}`}
                  // Read back by the marquee hit test, which measures rows from
                  // the DOM rather than tracking their geometry in state.
                  data-item-id={row.itemId}
                  className={selected.includes(row.itemId) ? styles.selectedRow : undefined}
                >
                  {canAppraise && (
                    <td className={styles.checkCell}>
                      {/* The label is the hitbox: padded well past the box
                          itself and pulled back by the same amount, so the
                          target is generous without the row getting taller. */}
                      <label className={styles.checkSlop}>
                        <input
                          type="checkbox"
                          checked={selected.includes(row.itemId)}
                          onChange={(event) => toggleRow(row.itemId, event.target.checked)}
                          aria-label="Select this item"
                        />
                      </label>
                    </td>
                  )}
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
                      <TypeIcon id={row.typeId} prefer={row.icon} />
                      {row.href ? (
                        // Ships open their own /ship page; containers drill into /asset.
                        <Link href={row.href}>
                          <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                          <LinkSpinner />
                        </Link>
                      ) : (
                        <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                      )}
                      {row.isCurrentShip && <span className={styles.badge}>current ship</span>}
                    </span>
                  </td>
                  {/* Blank rather than a zero when the SDE has no volume for
                      the type — nothing is known, not "it takes no space". */}
                  <td className={retro.num}>
                    {(() => {
                      const m3 = stackVolume(row)
                      return m3 == null ? null : formatVolume(m3)
                    })()}
                  </td>
                  <td>{row.groupName ?? '—'}</td>
                  <td>{row.categoryName ?? '—'}</td>
                  <td>{ownerMap.get(row.ownerId) ?? row.ownerId}</td>
                  <td>{row.flag ?? '—'}</td>
                  <td className={retro.num}>{row.contents > 0 ? row.contents : '—'}</td>
                </tr>
              ))}
              {ordered.length === 0 && (
                <tr>
                  <td colSpan={canAppraise ? 9 : 8}>No assets here for this owner.</td>
                </tr>
              )}
            </tbody>
          </table>
          {canAppraise && (
            // One appraisal for the whole selection rather than one per row:
            // the provider request budget is shared by the whole deployment,
            // so a column of buttons was always the wrong shape.
            <div className={styles.tableFooter}>
              <AppraisalPanel
                targets={selectedVisible}
                label={
                  selectedVisible.length > 0 ? `Appraise ${selectedVisible.length} selected` : 'Appraise selection'
                }
                emptyHint="Tick some rows, or drag a box over them, to appraise them."
              />
            </div>
          )}
          {/* The rectangle itself: viewport-positioned, so it tracks the pointer
              through a scroll, and click-through so it never eats the mouseup. */}
          {marquee && isDrag(marquee) ? (
            <div
              className={styles.marquee}
              style={{
                left: marquee.left,
                top: marquee.top,
                width: marquee.right - marquee.left,
                height: marquee.bottom - marquee.top,
              }}
              aria-hidden="true"
            />
          ) : null}
        </>
      ) : (
        <p>No assets known at this location.</p>
      )}
    </section>
  )
}
