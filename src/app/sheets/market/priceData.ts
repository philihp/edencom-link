// The pure half of /sheets/market/<market>/price_data: parse the chunk of type
// ids a sheet asks for, and render the answer as the XML IMPORTXML reads.
//
// The shape copies goonmetrics' price_data API (docs/market-prices/README.md
// "Chunked prices for IMPORTXML"), which a sheet calls one block of rows at a
// time:
//
//   =IMPORTXML("…/price_data/?type_id="&JOIN(",",$A$2:$A$101), "//price_data/type")
//
// so the same `//price_data/type` XPath selects one node per type. Two things
// differ on purpose:
//
//   1. Every requested id gets a node, in request order, duplicates included.
//      goonmetrics drops the ids it has no price for, which moves every row
//      after the gap up by one against the ids in column A. Here row n of the
//      result is always id n of the request.
//   2. The type id is the first child element, not only an attribute. IMPORTXML
//      shows element text and never attributes, so this puts the id in the
//      first result column, where a sheet can check the rows are aligned.
//
// A type node flattens to these columns, in this order — the same columns and
// order as the /sheets/market/<market> CSV:
//
//   type_id | updated | buy | sell | since | strategy
//
// An empty side of the book is an empty element, never 0, for the same reason
// the table stores null: "nobody bids" and "somebody bids 0" are two different
// facts. A type the market has never priced has only its type_id filled.
import { filter, map, pipe, split, trim } from 'ramda'

// A chunk is a block of sheet rows, not a market dump — goonmetrics sheets
// ask for 100. The cap keeps one request inside PostgREST's 1000-row page
// (a historical read can match two rows per type at a version boundary) and
// the URL inside what Sheets will send.
export const MAX_TYPE_IDS = 400

export type PriceRow = {
  type_id: number
  buy_max: number | string | null
  sell_min: number | string | null
  strategy: string | null
  // When this price took effect, and when a run last confirmed it.
  valid_from: string
  valid_until: string
}

export type TypeIdsResult = { ok: true; typeIds: number[] } | { ok: false; error: string }

const isTypeId = (value: string) => /^\d{1,19}$/.test(value) && Number(value) > 0

// `JOIN(",", $A$2:$A$101)` over a block that is not full gives trailing empty
// entries ("34,35,,,"), so empty entries are skipped rather than refused. Any
// other entry that is not a positive integer refuses the whole request: a
// silently dropped id would move every later row out of line with column A.
export const parseTypeIds = (raw: string | null): TypeIdsResult => {
  const entries = pipe(
    split(','),
    map(trim),
    filter((entry: string) => entry !== '')
  )(raw ?? '')
  const bad = entries.find((entry) => !isTypeId(entry))
  if (bad !== undefined) return { ok: false, error: `type_id must be a comma-separated list of type ids; got "${bad}"` }
  if (entries.length === 0) return { ok: false, error: 'type_id is required, e.g. ?type_id=34,35,36' }
  if (entries.length > MAX_TYPE_IDS)
    return { ok: false, error: `At most ${MAX_TYPE_IDS} type ids per request; got ${entries.length}` }
  return { ok: true, typeIds: map(Number, entries) }
}

// At the instant a version closes, the closed row's valid_until and the new
// row's valid_from are the same moment, so a historical read can match both.
// The newer version wins — the same answer a read a moment later would give.
export const latestByType = (rows: PriceRow[]): Map<number, PriceRow> =>
  rows.reduce((byType, row) => {
    const held = byType.get(Number(row.type_id))
    if (held === undefined || row.valid_from > held.valid_from) byType.set(Number(row.type_id), row)
    return byType
  }, new Map<number, PriceRow>())

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const element = (name: string, value: unknown): string =>
  `<${name}>${value === null || value === undefined ? '' : escapeXml(String(value))}</${name}>`

const typeNode =
  (byType: Map<number, PriceRow>) =>
  (typeId: number): string => {
    const row = byType.get(typeId)
    return [
      `    <type id="${typeId}">`,
      `      ${element('type_id', typeId)}`,
      `      ${element('updated', row?.valid_until)}`,
      `      ${element('buy', row?.buy_max)}`,
      `      ${element('sell', row?.sell_min)}`,
      `      ${element('since', row?.valid_from)}`,
      `      ${element('strategy', row?.strategy)}`,
      '    </type>',
    ].join('\n')
  }

export const priceDataXml = (market: string, typeIds: number[], rows: PriceRow[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<edencom method="price_data" market="${escapeXml(market)}">`,
    '  <price_data>',
    ...map(typeNode(latestByType(rows)), typeIds),
    '  </price_data>',
    '</edencom>',
  ].join('\n')
