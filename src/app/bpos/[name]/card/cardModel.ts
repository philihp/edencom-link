// The pure half of a blueprint library's link-preview card: which originals
// it draws, and how the chat embed describes the library. No I/O, so it is
// unit-tested (test/bposCard.test.ts).
import { ascend, descend, sortWith } from 'ramda'

import type { SdeType } from '@/sdeTypes'

import { type StackIcon, MAX_STACKS } from '../../../asset/[locationId]/card/cardModel.ts'
import { metaColor } from '../../../ship/[itemId]/card/cardModel.ts'
import type { BpoStack } from '../../stack.ts'

// One icon per blueprint type, however many ME/TE variants the page lists
// for it, the largest holdings first. Cut at MAX_STACKS: the page has the
// full list.
export const bpoStacks = (entries: readonly BpoStack[], types: Record<number, SdeType | undefined>): StackIcon[] =>
  sortWith<[number, number]>([descend(([, count]) => count), ascend(([typeId]) => typeId)])([
    ...entries
      .reduce((tally, entry) => tally.set(entry.typeId, (tally.get(entry.typeId) ?? 0) + entry.quantity), new Map())
      .entries(),
  ])
    .slice(0, MAX_STACKS)
    .map(([typeId, count]) => ({
      typeId,
      count,
      color: metaColor(types[typeId]?.metaGroupID),
      variation: 'bp' as const,
    }))

// "1 unique original", "12 unique originals".
export const uniqueOriginalsText = (unique: number): string =>
  `${unique} unique ${unique === 1 ? 'original' : 'originals'}`

// The line under the title in a chat embed.
export const bposDescription = (name: string, unique: number, total: number): string =>
  unique === 0
    ? `${name} holds no blueprint originals.`
    : `Blueprint originals held by ${name}: ${uniqueOriginalsText(unique)}${total !== unique ? `, ${total} in total` : ''}.`
