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
// - All numeric columns are numbers. PostgREST can send bigint and numeric
//   columns as strings, so the mappers convert them here, one time.

export type Side = 'sell' | 'buy'

export type Trade = {
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
