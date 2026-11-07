// One market trade, from the point of view of the side we were on. The two
// wallet transaction tables (character and corporation) map into this one
// shape, so every chart and table on the page reads one list.
//
// Rules:
// - `side` is 'sell' when we sold (ESI is_buy = false) and 'buy' when we bought.
// - `client_id` is the counterparty: the character or corporation on the other
//   side of the trade. universe_name holds its name when the universe-names job
//   has resolved it.
// - A personal trade has `registration_id` and no `corporation_id`. A
//   corporation trade has `corporation_id` and no `registration_id`.
// - `source` says where the trade comes from: 'market' for a wallet
//   transaction, 'contract' for a finished item exchange or auction (see
//   contracts.ts). A contract has no single item type and no unit price, so it
//   has `quantity` 1, `unit_price` = the ISK that moved, `type_id` 0, and its
//   items in `contract`. `transaction_id` is the contract id. Item tiles use
//   only market trades (`isMarket`).
// - All numeric columns are numbers. PostgREST can send bigint and numeric
//   columns as strings, so the mappers convert them here, one time.

import type { Payment } from './payments.ts'

export type Side = 'sell' | 'buy'

export type Source = 'market' | 'contract'

// One included item of a contract: what the issuer handed over.
export type ContractItem = { type_id: number; quantity: number }

export type ContractDetail = {
  title: string | null
  items: ContractItem[]
}

// A non-null `payment` means the value is inferred: the trade is a gift
// contract, and a player_donation journal entry paid for it (payments.ts).
export type Trade = {
  source: Source
  transaction_id: number
  side: Side
  registration_id: string | null
  corporation_id: number | null
  client_id: number
  location_id: number
  date: string
  type_id: number
  quantity: number
  unit_price: number
  seen_at: string
  // Null for a market trade.
  contract: ContractDetail | null
  // The journal entry that paid for a gift contract. Null for every other
  // trade.
  payment: Payment | null
}

type Num = number | string

// The columns both tables have in common, as the page selects them.
type CommonRow = {
  transaction_id: Num
  is_buy: boolean
  client_id: Num
  location_id: Num
  date: string
  type_id: Num
  quantity: Num
  unit_price: Num
  seen_at: string
}

export type CharacterTransactionRow = CommonRow & { registration_id: string }
export type CorpTransactionRow = CommonRow & { corporation_id: Num }

export const TRADE_COLUMNS =
  'transaction_id, is_buy, client_id, location_id, date, type_id, quantity, unit_price, seen_at'

const sideOf = (isBuy: boolean): Side => (isBuy ? 'buy' : 'sell')

const common = (r: CommonRow) => ({
  source: 'market' as const,
  contract: null,
  payment: null,
  transaction_id: Number(r.transaction_id),
  side: sideOf(r.is_buy),
  client_id: Number(r.client_id),
  location_id: Number(r.location_id),
  date: r.date,
  type_id: Number(r.type_id),
  quantity: Number(r.quantity),
  unit_price: Number(r.unit_price),
  seen_at: r.seen_at,
})

export const fromCharacterRow = (r: CharacterTransactionRow): Trade => ({
  ...common(r),
  registration_id: r.registration_id,
  corporation_id: null,
})

export const fromCorpRow = (r: CorpTransactionRow): Trade => ({
  ...common(r),
  registration_id: null,
  corporation_id: Number(r.corporation_id),
})

// True for a wallet transaction, false for a contract.
export const isMarket = (t: Trade): boolean => t.source === 'market'

// True when the value of the trade is inferred from a journal entry.
export const isInferred = (t: Trade): boolean => t.payment !== null
