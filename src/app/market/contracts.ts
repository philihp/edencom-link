import { filter, groupBy, map, pipe, reduce, values } from 'ramda'

import { contractDirection, contractSide, type ContractRow, type OurIds } from '../api/graphql/contracts.ts'
import type { Payment } from './payments.ts'
import type { ContractItem, Side, Trade } from './trade.ts'

// Finished item exchanges and auctions as market trades. Pure: the page reads
// the two contract views and the item tables, and these functions make the
// Trade list from the rows.
//
// Rules:
// - Only a finished item exchange or auction is a trade. contractDirection
//   (shared with GraphQL) gives the side from the ISK columns. A contract
//   where no ISK moves (a gift, or a courier-shaped exchange) is not a trade.
// - A contract between two parties of the account is internal and is not a
//   trade: the account's own characters and the corporations it directs.
// - The same contract can come from a character row and a corporation row.
//   The page counts it one time (see `oneRowPerContract`).
// - The value is the net ISK that moved: price minus reward for the issuer,
//   reward minus price for the acceptor. For an auction, `price` is the
//   starting bid; the extract does not keep the bids.

type Num = number | string

// The owner of the row that the page read: a character contract or a
// corporation contract.
export type ContractOwner =
  { kind: 'character'; registrationId: string } | { kind: 'corporation'; corporationId: number }

export type ContractTradeRow = ContractRow & {
  owner: ContractOwner
  contract_id: Num
  status: string | null
  title: string | null
  start_location_id: Num | null
  date_accepted: string | null
  date_completed: string | null
  seen_at: string
}

// The columns the page selects from both contract views.
export const CONTRACT_COLUMNS =
  'contract_id, type, status, for_corporation, issuer_id, issuer_corporation_id, acceptor_id, price, reward, title, start_location_id, date_accepted, date_completed, seen_at'

export const TRADE_KINDS = ['item_exchange', 'auction']

export const FINISHED = 'finished'

const idOf = (v: Num | null | undefined): string | null => (v == null ? null : String(v))

// The party that issued the contract: its corporation when the contract is for
// the corporation (the ISK goes to the corporation wallet), else the character.
export const issuerParty = (row: ContractRow): string | null =>
  row.for_corporation ? idOf(row.issuer_corporation_id) : idOf(row.issuer_id)

// The ids of every party in the account: its characters (EVE character ids)
// and the corporations where one of its characters is a director.
export const accountParties = (characterIds: Num[], directorCorporationIds: Num[]): ReadonlySet<string> =>
  new Set(map(String, [...characterIds, ...directorCorporationIds]))

// True when both parties are in the account. Such a contract moves items
// inside the account, so it is not a sale or a purchase.
export const isInternal =
  (parties: ReadonlySet<string>) =>
  (row: ContractRow): boolean => {
    const issuer = issuerParty(row)
    const acceptor = idOf(row.acceptor_id)
    return issuer !== null && acceptor !== null && parties.has(issuer) && parties.has(acceptor)
  }

// A for-corporation contract goes in the corporation wallet, so its
// corporation row wins. Any other contract goes in a character wallet, so its
// character row wins. When only one row exists, that row is used.
const preferred = (row: ContractTradeRow): number =>
  (row.owner.kind === 'corporation') === Boolean(row.for_corporation) ? 1 : 0

export const oneRowPerContract = (rows: ContractTradeRow[]): ContractTradeRow[] =>
  pipe(
    groupBy((r: ContractTradeRow) => String(r.contract_id)),
    values,
    map((group: ContractTradeRow[] | undefined) =>
      reduce(
        (best: ContractTradeRow, r: ContractTradeRow) => (preferred(r) > preferred(best) ? r : best),
        group![0],
        group!
      )
    )
  )(rows)

const isk = (v: Num | null | undefined): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

// The wallet our side of the contract used, as the "By" column shows it. A
// for-corporation issue and a corporation acceptor use the corporation wallet.
const ourWallet = (
  row: ContractTradeRow,
  side: 'issuer' | 'acceptor',
  ours: OurIds
): Pick<Trade, 'registration_id' | 'corporation_id'> => {
  const corporation =
    side === 'issuer'
      ? row.for_corporation
        ? Number(row.issuer_corporation_id)
        : null
      : ours.corporationIds.has(String(row.acceptor_id)) && !ours.characterIds.has(String(row.acceptor_id))
        ? Number(row.acceptor_id)
        : null
  if (corporation !== null) return { registration_id: null, corporation_id: corporation }
  return row.owner.kind === 'character'
    ? { registration_id: row.owner.registrationId, corporation_id: null }
    : { registration_id: null, corporation_id: row.owner.corporationId }
}

export type ContractTradeInput = {
  ours: OurIds
  // accountParties(...): the parties that make a contract internal.
  parties: ReadonlySet<string>
  // contract id → its included items.
  items: Map<string, ContractItem[]>
  // contract id → the journal entry that paid for a gift (payments.ts). A
  // gift with an entry here is a sale; its value is the amount of the entry.
  payments?: Map<string, Payment>
}

// One contract row as a trade, or null when it is not a trade.
export const contractTrade =
  ({ ours, parties, items, payments }: ContractTradeInput) =>
  (row: ContractTradeRow): Trade | null => {
    if (row.status !== FINISHED || !TRADE_KINDS.includes(row.type)) return null
    if (isInternal(parties)(row)) return null
    const payment = payments?.get(String(row.contract_id))
    if (payment !== undefined) return paidGift(row, payment, ours, items)
    const direction = contractDirection(row, ours)
    const side = contractSide(row, ours)
    const date = row.date_completed ?? row.date_accepted
    if (direction === 'neither' || side === null || date == null) return null
    const counterparty = side === 'issuer' ? idOf(row.acceptor_id) : issuerParty(row)
    if (counterparty === null) return null
    const value = Math.abs(isk(row.price) - isk(row.reward))
    const tradeSide: Side = direction === 'sold' ? 'sell' : 'buy'
    return {
      source: 'contract',
      transaction_id: Number(row.contract_id),
      side: tradeSide,
      ...ourWallet(row, side, ours),
      client_id: Number(counterparty),
      location_id: Number(row.start_location_id ?? 0),
      date,
      type_id: 0,
      quantity: 1,
      unit_price: value,
      seen_at: row.seen_at,
      contract: { title: row.title || null, items: items.get(String(row.contract_id)) ?? [] },
      payment: null,
    }
  }

// A gift that a journal entry paid for: a sale to the acceptor, with the
// amount of the entry as its value. The value is inferred, so the trade
// carries the entry.
const paidGift = (
  row: ContractTradeRow,
  payment: Payment,
  ours: OurIds,
  items: Map<string, ContractItem[]>
): Trade | null => {
  const date = row.date_completed ?? row.date_accepted
  if (date == null || row.acceptor_id == null) return null
  return {
    source: 'contract',
    transaction_id: Number(row.contract_id),
    side: 'sell',
    ...ourWallet(row, 'issuer', ours),
    client_id: Number(row.acceptor_id),
    location_id: Number(row.start_location_id ?? 0),
    date,
    type_id: 0,
    quantity: 1,
    unit_price: payment.amount,
    seen_at: row.seen_at,
    contract: { title: row.title || null, items: items.get(String(row.contract_id)) ?? [] },
    payment,
  }
}

// Every row as a trade: one row per contract, then the trades only.
export const contractTrades =
  (input: ContractTradeInput) =>
  (rows: ContractTradeRow[]): Trade[] =>
    filter((t: Trade | null): t is Trade => t !== null, map(contractTrade(input), oneRowPerContract(rows))) as Trade[]

type ItemRow = { contract_id: Num; type_id: Num; quantity: Num }

// Group the included item rows by contract. The Map is the accumulator, so
// the fold stays O(n).
export const itemsByContract = (rows: ItemRow[]): Map<string, ContractItem[]> =>
  reduce(
    (acc: Map<string, ContractItem[]>, r: ItemRow) => {
      const key = String(r.contract_id)
      const list = acc.get(key) ?? []
      list.push({ type_id: Number(r.type_id), quantity: Number(r.quantity) })
      return acc.set(key, list)
    },
    new Map<string, ContractItem[]>(),
    rows
  )

// The label of a contract row in the table: "Contract · 3 items".
export const contractLabel = (items: ContractItem[]): string =>
  `Contract · ${items.length} item${items.length === 1 ? '' : 's'}`
