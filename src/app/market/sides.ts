import { ascend, descend, filter, map, pipe, prop, sortWith } from 'ramda'

import { totalsBy, type Totals } from './aggregate.ts'
import type { Side, Trade } from './trade.ts'

// The two tabs of the market page: what we sold and what we bought. The page
// shows one side at a time. The time window applies to both sides.

export const SIDES: Side[] = ['sell', 'buy']

export const SIDE_STORAGE_KEY = 'market.side'
export const DEFAULT_SIDE: Side = 'sell'

// Read the saved tab back from storage. An unknown value gives undefined, so
// usePersist keeps the default.
export const parseSide = (raw: string): Side | undefined => SIDES.find((s) => s === raw)

export type SideCopy = {
  // The tab label.
  tab: string
  // The plural noun for the trades on this side: "sales", "purchases".
  noun: string
  // The past-tense verb for one trade: "sold", "bought".
  verb: string
  // The role of the counterparty on this side. When we sell, the other side
  // buys; when we buy, the other side sells.
  counterparty: string
}

// The Record type makes the build fail if a new Side has no copy.
export const SIDE_COPY: Record<Side, SideCopy> = {
  sell: { tab: 'sales', noun: 'sales', verb: 'sold', counterparty: 'buyer' },
  buy: { tab: 'purchases', noun: 'purchases', verb: 'bought', counterparty: 'seller' },
}

// The first letter in upper case, for a heading made from the copy above.
export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// The name of a counterparty, or its raw id when universe_name does not know it.
export const counterpartyLabel =
  (names: Record<number, string>) =>
  (clientId: number): string =>
    names[clientId] ?? `#${clientId}`

export type WhoOption = Totals & { clientId: number; label: string }

// The counterparties in a list of trades, for the "Who" filter. The largest ISK
// total comes first. Equal totals sort by label, then by id, so the order does
// not change with the order of the input.
export const whoOptions = (names: Record<number, string>, trades: Trade[]): WhoOption[] =>
  pipe(
    totalsBy(prop('client_id')),
    (totals: Map<number, Totals>) => [...totals.entries()],
    map(([clientId, t]: [number, Totals]): WhoOption => ({
      clientId,
      label: counterpartyLabel(names)(clientId),
      ...t,
    })),
    sortWith<WhoOption>([descend(prop('total')), ascend(prop('label')), ascend(prop('clientId'))])
  )(trades)

// The "Who" filter value: null is every counterparty.
export const byWho = (who: number | null) =>
  who === null ? (ts: Trade[]) => ts : filter<Trade>((t) => t.client_id === who)

// Read a saved "Who" value back: an empty string is every counterparty, a
// positive integer is one client_id, anything else is refused.
export const parseWho = (raw: string): number | null | undefined => {
  if (raw === '') return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}
