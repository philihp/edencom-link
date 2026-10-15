// The pure half of a container's link-preview card: what the card shows,
// folded from the rows the share link opens. No I/O and no JSX, so it is
// unit-tested (test/assetCard.test.ts). ./loadCard.ts does the reads and
// ./route.tsx the drawing.
//
// The ship card (ship/[itemId]/card) shows a hull's fit slot by slot. A
// container has no slots, so its card shows what is in it instead: one icon
// per stack, the most valuable first, with how many there are and what the
// lot is worth.
import { ascend, descend, sortWith } from 'ramda'

import type { SdeType } from '@/sdeTypes'

import { iconVariation, type IconVariation } from '../../../iconVariation.ts'
import { compactIsk, metaColor, type CardValue } from '../../../ship/[itemId]/card/cardModel.ts'

// One item directly inside the container, as the share page lists it.
export type ContainerChild = {
  typeId: number
  quantity: number
  isBlueprintCopy: boolean | null
}

export type StackIcon = {
  typeId: number
  // Units of this type in the container, shown as a badge where more than one.
  count: number
  color: string
  // Which artwork the image server holds for it (iconVariation.ts): the card
  // is drawn on the server, which cannot ask and correct a wrong guess.
  variation: IconVariation
}

// Three rows of icons fit beside the container's picture.
export const MAX_STACKS = 33

// The container's contents as icons, one per type (originals and copies of a
// blueprint apart, since their artwork differs), the most valuable stacks
// first and then the largest. `unitSell` prices a type by name; a type with no
// price sorts after every priced one. Cut at MAX_STACKS: the page has the
// full list.
export const containerStacks = (
  children: ContainerChild[],
  types: Record<number, SdeType | undefined>,
  unitSell: (name: string) => number | null
): StackIcon[] => {
  const stacks = children.reduce((tally, child) => {
    // ESI sets the flag only on blueprints.
    const isCopy = child.isBlueprintCopy === true
    const key = `${child.typeId}:${isCopy}`
    const stack = tally.get(key)
    return tally.set(key, {
      typeId: child.typeId,
      isCopy,
      count: (stack?.count ?? 0) + child.quantity,
    })
  }, new Map<string, { typeId: number; isCopy: boolean; count: number }>())

  const worth = (stack: { typeId: number; count: number }): number => {
    const name = types[stack.typeId]?.name
    const price = name == null ? null : unitSell(name)
    return price == null ? -1 : price * stack.count
  }

  return sortWith<{ typeId: number; isCopy: boolean; count: number }>([
    descend(worth),
    descend((stack) => stack.count),
    ascend((stack) => stack.typeId),
  ])([...stacks.values()])
    .slice(0, MAX_STACKS)
    .map((stack) => ({
      typeId: stack.typeId,
      count: stack.count,
      color: metaColor(types[stack.typeId]?.metaGroupID),
      variation: iconVariation(types[stack.typeId]?.categoryID, stack.isCopy),
    }))
}

// A stack size the way a badge can fit it: "12", "1.5k", "2.3m".
export const compactCount = (count: number): string => {
  const [divisor, unit] = count >= 1e9 ? [1e9, 'b'] : count >= 1e6 ? [1e6, 'm'] : count >= 1e4 ? [1e3, 'k'] : [1, '']
  const scaled = count / divisor
  return `${Number(scaled.toFixed(scaled >= 100 || unit === '' ? 0 : 1))}${unit}`
}

// "1 item", "12 items": what the share page lists, one entry per row.
export const itemCountText = (count: number): string => `${count} ${count === 1 ? 'item' : 'items'}`

// The line under the title in a chat embed.
export const containerDescription = (
  typeName: string,
  groupName: string | null,
  ownerName: string,
  itemCount: number,
  value: CardValue
): string =>
  [
    `${groupName && groupName !== typeName ? `${typeName} (${groupName})` : typeName}, owned by ${ownerName}.`,
    itemCount === 0 ? 'Empty.' : `${itemCountText(itemCount)}.`,
    value.sell == null ? null : `Estimated value ${compactIsk(value.sell)}.`,
  ]
    .filter((part) => part != null)
    .join(' ')

// A place share (docs/sharing-layer/15-place-share.md) names a station, a
// structure or a solar system rather than an item.
export type PlaceKind = 'station' | 'structure' | 'system'

export const PLACE_KIND_NAME: Record<PlaceKind, string> = {
  station: 'Station',
  structure: 'Structure',
  system: 'Solar system',
}

// The line under the title in a chat embed, for a place share: whose assets
// these are and where, then the same count and value as a container.
export const placeDescription = (
  placeName: string,
  kind: PlaceKind,
  ownerName: string,
  itemCount: number,
  value: CardValue
): string =>
  [
    `Assets of ${ownerName} at ${placeName} (${PLACE_KIND_NAME[kind].toLowerCase()}).`,
    itemCount === 0 ? 'Empty.' : `${itemCountText(itemCount)}.`,
    value.sell == null ? null : `Estimated value ${compactIsk(value.sell)}.`,
  ]
    .filter((part) => part != null)
    .join(' ')
