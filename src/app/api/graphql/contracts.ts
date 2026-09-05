// The CONTRACT dimension of the GraphQL filters, and the one thing a contract
// row does not carry: which way the ISK went.
//
// Pure, like filters.ts and hangarFlags.ts, so test/graphqlContracts.test.ts can
// exercise it under the node test runner.
//
// ESI stores a contract from nobody's point of view. It names an issuer, an
// acceptor, a `price` and a `reward`, and leaves "did I buy or sell this" to be
// worked out from which side you were on. That answer is the whole reason to
// search contracts at all — "what did I buy last week" — so it is computed
// here, once, rather than left to every caller to get subtly wrong.
import { parseRefFilter } from './filters.ts'

// Which side of the contract we were on. Null when neither side is ours, which
// a row can be: a contract is visible to both parties, and a corp contract is
// visible to every member whether or not they touched it.
export type ContractSide = 'issuer' | 'acceptor' | null

// What the contract did to our wallet.
export type ContractDirection = 'bought' | 'sold' | 'neither'

export type ContractRow = {
  type: string
  for_corporation?: boolean | null
  issuer_id?: number | string | null
  issuer_corporation_id?: number | string | null
  acceptor_id?: number | string | null
  price?: number | string | null
  reward?: number | string | null
}

// Who we are, as the ids a contract names. Characters and corporations are
// separate because `issuer_id` is always a character while `acceptor_id` may be
// either — an acceptor can be a corporation.
export type OurIds = {
  characterIds: ReadonlySet<string>
  corporationIds: ReadonlySet<string>
}

const has = (ids: ReadonlySet<string>, id: number | string | null | undefined): boolean =>
  id != null && ids.has(String(id))

export const contractSide = (row: ContractRow, ours: OurIds): ContractSide => {
  // Issued by one of our characters, or issued on behalf of one of our
  // corporations — `for_corporation` is what says the ISK lands in the corp
  // wallet rather than the issuing character's.
  if (has(ours.characterIds, row.issuer_id)) return 'issuer'
  if (row.for_corporation && has(ours.corporationIds, row.issuer_corporation_id)) return 'issuer'
  // The acceptor id is a character or a corporation, so both sets are tried.
  if (has(ours.characterIds, row.acceptor_id) || has(ours.corporationIds, row.acceptor_id)) return 'acceptor'
  return null
}

// Only an exchange of items for ISK is a purchase or a sale. A courier contract
// pays a `reward` for hauling and a loan moves ISK against collateral — reading
// either as "bought" would file every shipping fee as a purchase, which is the
// kind of wrong answer a saved report repeats for a year.
const TRADES = new Set(['item_exchange', 'auction'])

const isk = (value: number | string | null | undefined): number => {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

// ESI's two money columns are directional: the acceptor pays `price` to the
// issuer, and the issuer pays `reward` to the acceptor. So the same contract is
// a sale from one side and a purchase from the other, and a want-to-buy
// contract (the issuer offering a reward for goods) is a purchase for the
// issuer — which is why this reads the ISK rather than assuming issuer sells.
export const contractDirection = (row: ContractRow, ours: OurIds): ContractDirection => {
  if (!TRADES.has(row.type)) return 'neither'
  const side = contractSide(row, ours)
  if (side === null) return 'neither'
  const received = side === 'issuer' ? isk(row.price) : isk(row.reward)
  const paid = side === 'issuer' ? isk(row.reward) : isk(row.price)
  if (received > paid) return 'sold'
  if (paid > received) return 'bought'
  // Equal, and usually both zero: a courier-shaped item exchange, or a gift.
  return 'neither'
}

export type DirectionFilter = { ok: true; direction: ContractDirection | null } | { ok: false; message: string }

const DIRECTIONS = ['bought', 'sold', 'neither'] as const

// Absent means no filter. Anything outside the vocabulary is refused with it
// listed, the way every other dimension refuses an entry that matches nothing.
export const parseDirectionFilter = (direction: string | null | undefined): DirectionFilter => {
  const wanted = (direction ?? '').trim().toLowerCase()
  if (wanted === '') return { ok: true, direction: null }
  const found = DIRECTIONS.find((d) => d === wanted)
  if (!found) {
    return { ok: false, message: `No such direction "${direction}". Available: ${DIRECTIONS.join(', ')}.` }
  }
  return { ok: true, direction: found }
}

// The contract KIND — ESI's own `type` column (item_exchange, courier, auction,
// loan). Named kind because `type`/`types` is the ITEM type on every list in
// this schema, and one word cannot mean both. Stored raw by the extract so a
// new member CCP adds lands in the table, which is also why this matches
// whatever is asked rather than a closed vocabulary: the singular is a
// substring search, the plural an exact list, as everywhere else.
export type KindMatch = { ok: true; kinds: string[] | null } | { ok: false; message: string }

export const KNOWN_KINDS = ['item_exchange', 'courier', 'auction', 'loan', 'unknown'] as const

export const matchKindFilter = (
  kind: string | null | undefined,
  kinds: readonly string[] | null | undefined
): KindMatch => {
  const parsed = parseRefFilter(kind, kinds, 'kind')
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const query = parsed.query
  if (query.kind === 'none') return { ok: true, kinds: null }

  if (query.kind === 'search') {
    const wanted = query.term.toLowerCase()
    const matched = KNOWN_KINDS.filter((k) => k.includes(wanted))
    if (matched.length === 0) {
      return { ok: false, message: `No contract kind matched "${query.term}". Known: ${KNOWN_KINDS.join(', ')}.` }
    }
    return { ok: true, kinds: [...matched] }
  }
  // Exact entries pass through lowercased: the column holds ESI's raw token, so
  // an unknown one is a legitimate ask rather than a typo to refuse.
  return { ok: true, kinds: [...new Set(query.entries.map((e) => e.toLowerCase()))] }
}

// What was in the contract, as one flat cell — "12 × Tritanium, 1 × Rifter".
// Flat because a Link renders its query as CSV and a nested list has no column
// to live in; this is what makes a row answerable ("what did I buy") without
// nesting. Only INCLUDED items are named: an item_exchange also lists what the
// issuer asked for, and folding the two together would read as one basket.
export type ContractItemRow = { type_id: number | string; quantity: number | string; is_included: boolean }

export const summariseItems = (
  items: readonly ContractItemRow[],
  nameOf: (typeId: number | string) => string | null,
  limit = 6
): string | null => {
  const included = items.filter((i) => i.is_included)
  if (included.length === 0) return null
  // Same type across several records is one line, as a hangar stack would be.
  const byType = new Map<string, number>()
  included.forEach((item) => {
    const key = String(item.type_id)
    byType.set(key, (byType.get(key) ?? 0) + Number(item.quantity ?? 0))
  })
  const parts = [...byType.entries()].map(
    ([typeId, quantity]) => `${quantity.toLocaleString('en-US')} × ${nameOf(typeId) ?? `#${typeId}`}`
  )
  return parts.length <= limit
    ? parts.join(', ')
    : `${parts.slice(0, limit).join(', ')} and ${parts.length - limit} more`
}
