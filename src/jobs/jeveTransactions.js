import { chain, filter, fromPairs, groupBy, map, pipe, prop, toPairs, uniqBy } from 'ramda'

// The pure half of the jEveAssets transaction backfill
// (src/jobs/importJeveTransactions.js): read a profile's wallet transactions
// and translate them into character_wallet_transaction rows.
//
// jEveAssets stores each ESI transaction under its own column names
// (ProfileTransactions.java, ProfileReader.parseTransaction). This file is the
// one place they are translated back to ESI's.

// The SQLite profile stores a date as epoch milliseconds. An XML export can
// hold milliseconds or "yyyy-MM-dd HH:mm:ss"; EVE time is UTC, so read the
// text form as UTC.
export const toIso = (v) =>
  /^\d+$/.test(String(v))
    ? new Date(Number(v)).toISOString()
    : new Date(`${String(v).replace(' ', 'T')}Z`).toISOString()

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v))

// jEveAssets writes 0 when ESI gave no journal reference.
const refOrNull = (v) => (num(v) ? Number(v) : null)

export const toRow = (registration_id, t) => ({
  transaction_id: Number(t.transactionid),
  registration_id,
  date: toIso(t.transactiondatetime),
  type_id: Number(t.typeid),
  quantity: Number(t.quantity),
  unit_price: Number(t.price),
  is_buy: String(t.transactiontype).toLowerCase() === 'buy',
  is_personal: String(t.transactionfor).toLowerCase() === 'personal',
  client_id: num(t.clientid),
  location_id: num(t.stationid),
  journal_ref_id: refOrNull(t.journaltransactionid),
})

// Attribute order inside a tag is not fixed, so read each tag as a bag of
// attributes.
export const attrs = (tag) => fromPairs(map(([, k, v]) => [k, v], [...tag.matchAll(/(\w+)="([^"]*)"/g)]))

// jEveAssets writes XML exports with a byte-order mark and Java's default
// (big-endian) order, so the mark picks the decoder.
export const decodeUtf16 = (buf) =>
  new TextDecoder(buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : 'utf-16le').decode(buf)

// → [{ characterId, name, transactions: [attrs…] }] from profile XML text.
export const parseXml = (text) =>
  map(
    (m) => {
      const owner = attrs(m[1])
      return {
        characterId: Number(owner.id),
        name: owner.name,
        transactions: map((t) => attrs(t[1]), [...m[2].matchAll(/<wallettransaction ([^>]*)\/>/g)]),
      }
    },
    [...text.matchAll(/<esiowner ([^>]*)>([\s\S]*?)<\/esiowner>/g)]
  )

// → { [characterId]: [registration ids…] }. A character with more than one
// registration is ambiguous: the caller must not guess which one owns it.
export const registrationsByCharacter = pipe(
  groupBy((r) => String(r.character_id)),
  map(map(prop('id')))
)

// Sources and registrations → { rows, skipped }. A source whose character has
// no registration, or more than one, is skipped and named in `skipped`.
export const toRows = (sources, registrations) => {
  const byCharacter = registrationsByCharacter(registrations)
  const ownerOf = (s) => byCharacter[String(s.characterId)] ?? []
  const usable = filter((s) => ownerOf(s).length === 1, sources)
  const skipped = pipe(
    filter((s) => ownerOf(s).length !== 1),
    uniqBy(prop('characterId')),
    map((s) => ({
      characterId: s.characterId,
      name: s.name,
      reason: ownerOf(s).length === 0 ? 'not registered here' : `${ownerOf(s).length} registrations`,
    }))
  )(sources)
  const rows = pipe(
    chain((s) => map((t) => toRow(ownerOf(s)[0], t), s.transactions)),
    uniqBy(prop('transaction_id'))
  )(usable)
  return { rows, skipped }
}

// → [[registration_id, { count, first, last }]] for the report.
export const summarize = pipe(
  groupBy(prop('registration_id')),
  toPairs,
  map(([id, rs]) => [
    id,
    {
      count: rs.length,
      sells: filter((r) => !r.is_buy, rs).length,
      first: rs.reduce((a, r) => (r.date < a ? r.date : a), rs[0].date),
      last: rs.reduce((a, r) => (r.date > a ? r.date : a), rs[0].date),
    },
  ])
)
