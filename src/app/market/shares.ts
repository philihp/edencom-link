import { map } from 'ramda'
import { match } from 'ts-pattern'

import type { Datum } from '../charts/arcs.ts'
import type { CounterpartyTotal, TypeTotal } from './aggregate.ts'
import { counterpartyLabel } from './sides.ts'

// Pure inputs for the market page's donuts and the counterparty tile. The
// donut does the top-N cut and the "other" slice itself, so these functions
// give every row, not only the top rows.

// The kind of an EVE id, as universe_name records it in its category column.
export type CounterpartyKind = 'character' | 'corporation' | 'alliance'

const KINDS: readonly string[] = ['character', 'corporation', 'alliance']

// Read a universe_name category. A category that is not one of the three kinds
// (for example "faction" or "station") gives undefined.
export const parseKind = (raw: string): CounterpartyKind | undefined =>
  KINDS.includes(raw) ? (raw as CounterpartyKind) : undefined

// One donut datum per counterparty. A counterparty with no name shows its raw id.
export const counterpartyShare = (names: Record<number, string>): ((rows: CounterpartyTotal[]) => Datum[]) =>
  map((r) => ({ key: String(r.clientId), label: counterpartyLabel(names)(r.clientId), value: r.total }))

// One donut datum per item type. A type with no name shows its raw id.
export const typeShare = (names: Record<number, string>): ((rows: TypeTotal[]) => Datum[]) =>
  map((r) => ({ key: String(r.typeId), label: names[r.typeId] ?? `#${r.typeId}`, value: r.total }))

// The image of a counterparty on the EVE image server: the portrait of a
// character, the logo of a corporation or an alliance. An id of unknown kind
// gives null, so the tile shows no image (a wrong guess is a broken image).
export const counterpartyImage = (kind: CounterpartyKind | undefined, id: number, size = 64): string | null =>
  kind === undefined
    ? null
    : match(kind)
        .with('character', () => `https://images.evetech.net/characters/${id}/portrait?size=${size}`)
        .with('corporation', () => `https://images.evetech.net/corporations/${id}/logo?size=${size}`)
        .with('alliance', () => `https://images.evetech.net/alliances/${id}/logo?size=${size}`)
        .exhaustive()
