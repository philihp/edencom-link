// The pure half of the ship's link-preview card: what the card shows, folded
// from the rows the share link opens. No I/O and no JSX, so it is unit-tested
// (test/shipCard.test.ts). The route in ./route.tsx does the reads and the
// drawing.
//
// The card copies how other games let a player post an item into a chat: the
// thing itself, drawn big, in the colour of its quality tier, with what it is
// made of beside it. Here that is the hull render, its fitted modules slot by
// slot, its drones, who owns it and what it is worth.
import { ascend, sortWith } from 'ramda'

import type { SdeType } from '@/sdeTypes'

// The card's size in pixels: the 1.91:1 shape Open Graph and X large-image
// cards expect.
export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630

// invCategories ids the fold branches on.
const CHARGE_CATEGORY_ID = 8
const BLUEPRINT_CATEGORY_ID = 9

export type CardChild = {
  typeId: number
  flag: string | null
  quantity: number
  isBlueprintCopy: boolean
}

export type CardIcon = {
  typeId: number
  // Stack size, shown as a badge where it is more than one (drones, fighters).
  count: number
  color: string
}

export type CardRow = { label: string; icons: CardIcon[] }

export type CardValue = {
  // Σ quantity × best Jita ask over the hull and everything directly inside
  // it. Null when not one line had a price.
  sell: number | null
  // Lines with no price, left out of the sum (the card says so).
  unpriced: number
}

// Quality-tier colours by invMetaGroups id — the card's version of an item's
// rarity colour in Diablo or World of Warcraft. The border, the name and each
// module's frame take the colour of their own tier.
const META_COLORS: Record<number, string> = {
  1: '#d8dde6', // Tech I
  2: '#f0a53a', // Tech II
  3: '#9ccc65', // Storyline
  4: '#3fc16b', // Faction
  5: '#b36bff', // Officer
  6: '#4aa3ff', // Deadspace
  14: '#ff6a4d', // Tech III
  15: '#ff4fa3', // Abyssal
}
const DEFAULT_COLOR = META_COLORS[1]

export const metaColor = (metaGroupID: number | null | undefined): string =>
  (metaGroupID != null && META_COLORS[metaGroupID]) || DEFAULT_COLOR

// Fitted slots, in the order the fitting window lists them. One icon for each
// fitted module, not collapsed: eight identical guns are eight icons, as they
// are eight slots.
const SLOT_ROWS: [string, string][] = [
  ['HiSlot', 'High'],
  ['MedSlot', 'Mid'],
  ['LoSlot', 'Low'],
  ['RigSlot', 'Rigs'],
  ['SubSystemSlot', 'Subsystems'],
]

// Bays whose contents a player shows off, stacked by type with a count.
const STACK_ROWS: [string, string][] = [
  ['DroneBay', 'Drones'],
  ['FighterBay', 'Fighters'],
]

// A row holds at most this many icons; the card is 1200px wide.
export const MAX_ICONS = 11

const slotIndex = (flag: string): number => Number(flag.replace(/^\D+/, '')) || 0

const slotRow =
  (types: Record<number, SdeType>) =>
  ([prefix, label]: [string, string], children: CardChild[]): CardRow => ({
    label,
    icons: sortWith<CardChild>([ascend((c) => slotIndex(c.flag ?? '')), ascend((c) => c.typeId)])(
      // A loaded charge shares its launcher's slot flag; the card shows the
      // launcher.
      children.filter((c) => c.flag?.startsWith(prefix) && types[c.typeId]?.categoryID !== CHARGE_CATEGORY_ID)
    ).map((c) => ({ typeId: c.typeId, count: 1, color: metaColor(types[c.typeId]?.metaGroupID) })),
  })

const stackRow =
  (types: Record<number, SdeType>) =>
  ([flag, label]: [string, string], children: CardChild[]): CardRow => ({
    label,
    icons: [
      ...children
        .filter((c) => c.flag === flag)
        .reduce(
          (stacks, c) => stacks.set(c.typeId, (stacks.get(c.typeId) ?? 0) + c.quantity),
          new Map<number, number>()
        ),
    ]
      .sort(([a], [b]) => a - b)
      .map(([typeId, count]) => ({ typeId, count, color: metaColor(types[typeId]?.metaGroupID) })),
  })

// The rows the card draws, empty ones dropped. A row longer than MAX_ICONS is
// cut; the page itself has the full list.
export const cardRows = (children: CardChild[], types: Record<number, SdeType>): CardRow[] =>
  [...SLOT_ROWS.map((row) => slotRow(types)(row, children)), ...STACK_ROWS.map((row) => stackRow(types)(row, children))]
    .filter((row) => row.icons.length > 0)
    .map((row) => ({ ...row, icons: row.icons.slice(0, MAX_ICONS) }))

// A blueprint copy has no market price, and an original's is an order book of
// a few listings — neither says what the ship is worth, so both stay out, as
// they do in the page's own appraisal.
const isBlueprint = (child: CardChild, types: Record<number, SdeType>) =>
  child.isBlueprintCopy || types[child.typeId]?.categoryID === BLUEPRINT_CATEGORY_ID

export const cardValue = (
  hullTypeId: number,
  children: CardChild[],
  types: Record<number, SdeType>,
  sellPrices: Map<number, number | null>
): CardValue => {
  const lines = [
    { typeId: hullTypeId, quantity: 1 },
    ...children.filter((c) => !isBlueprint(c, types)).map((c) => ({ typeId: c.typeId, quantity: c.quantity })),
  ]
  const priced = lines.filter((line) => sellPrices.get(line.typeId) != null)
  return {
    sell:
      priced.length === 0
        ? null
        : priced.reduce((sum, line) => sum + line.quantity * Number(sellPrices.get(line.typeId)), 0),
    unpriced: lines.length - priced.length,
  }
}

// ISK the way players say it in chat: "1.23b", "450m", "12.5k".
export const compactIsk = (value: number): string => {
  const [divisor, unit] =
    value >= 1e12
      ? [1e12, 't']
      : value >= 1e9
        ? [1e9, 'b']
        : value >= 1e6
          ? [1e6, 'm']
          : value >= 1e3
            ? [1e3, 'k']
            : [1, '']
  const scaled = value / divisor
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${Number(scaled.toFixed(digits))}${unit} ISK`
}

// The line under the title in a chat embed.
export const cardDescription = (
  typeName: string,
  groupName: string | null,
  ownerName: string,
  rows: CardRow[],
  value: CardValue
): string =>
  [
    `${groupName ? `${typeName} (${groupName})` : typeName}, owned by ${ownerName}.`,
    rows.length > 0
      ? `${rows.map((row) => `${row.label} ${row.icons.reduce((n, icon) => n + icon.count, 0)}`).join(' · ')}.`
      : null,
    value.sell == null ? null : `Estimated value ${compactIsk(value.sell)} at Jita sell.`,
  ]
    .filter((part) => part != null)
    .join(' ')
