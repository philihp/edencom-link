import { ascend, filter, map, partition, pipe, prop, reduce, sortWith, uniqBy } from 'ramda'

// The pure part of /contract/[contractId]: which of the rows the caller can
// read is the contract, its items in two lists, its status history, and the
// labels. No I/O, so the page reads the rows and these functions shape them.
//
// Rules:
// - A contract can come from a character row and a corporation row (both
//   parties can be ours, or a character and its corporation both see it).
//   The facts are the same in both. A for-corporation contract prefers the
//   corporation row, any other contract the character row, as /market does.
// - The status history is the history of the chosen row's owner only: two
//   owners saw the contract on different runs, and to mix them makes steps
//   that never happened.
// - An item row with `is_included` is what the issuer hands over. An item row
//   without it is what the issuer asks for in return. The same record can come
//   from both item tables, so a record counts one time.

type Num = number | string

export type ContractOwner =
  { kind: 'character'; registrationId: string } | { kind: 'corporation'; corporationId: number }

export type ContractRow = {
  owner: ContractOwner
  contract_id: Num
  type: string
  status: string | null
  status_since: string | null
  availability: string
  for_corporation: boolean | null
  issuer_id: Num
  issuer_corporation_id: Num
  assignee_id: Num | null
  acceptor_id: Num | null
  start_location_id: Num | null
  end_location_id: Num | null
  title: string | null
  price: Num | null
  reward: Num | null
  collateral: Num | null
  buyout: Num | null
  volume: Num | null
  days_to_complete: Num | null
  date_issued: string
  date_expired: string
  date_accepted: string | null
  date_completed: string | null
  seen_at: string
}

// The columns the page selects from both contract views.
export const CONTRACT_PAGE_COLUMNS =
  'contract_id, type, status, status_since, availability, for_corporation, issuer_id, issuer_corporation_id, assignee_id, acceptor_id, start_location_id, end_location_id, title, price, reward, collateral, buyout, volume, days_to_complete, date_issued, date_expired, date_accepted, date_completed, seen_at'

// Contract ids are positive integers. Anything else is not a contract.
export const parseContractId = (raw: string): number | null => {
  if (!/^[1-9][0-9]{0,18}$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}

const preference = (row: ContractRow): number =>
  (row.owner.kind === 'corporation') === Boolean(row.for_corporation) ? 1 : 0

// The row that stands for the contract, or null when the caller reads none.
export const pickContract = (rows: ContractRow[]): ContractRow | null =>
  reduce<ContractRow, ContractRow | null>(
    (best, row) => (best === null || preference(row) > preference(best) ? row : best),
    null,
    rows
  )

export const ownerKey = (owner: ContractOwner): string =>
  owner.kind === 'character' ? `character:${owner.registrationId}` : `corporation:${owner.corporationId}`

type ItemRow = {
  record_id: Num
  type_id: Num
  quantity: Num
  is_included: boolean
  is_singleton: boolean
  raw_quantity: Num | null
}

export type Blueprint = 'original' | 'copy' | null

export type ContractLine = {
  recordId: number
  typeId: number
  quantity: number
  singleton: boolean
  blueprint: Blueprint
}

// ESI's raw_quantity marks a blueprint: -1 an original, -2 a copy.
export const blueprintOf = (raw: Num | null): Blueprint => {
  const n = raw == null ? null : Number(raw)
  return n === -1 ? 'original' : n === -2 ? 'copy' : null
}

const toLine = (r: ItemRow): ContractLine => ({
  recordId: Number(r.record_id),
  typeId: Number(r.type_id),
  quantity: Number(r.quantity),
  singleton: r.is_singleton,
  blueprint: blueprintOf(r.raw_quantity),
})

export type ContractLines = { offered: ContractLine[]; asked: ContractLine[] }

// The items in two lists, each in the order ESI gave them (record id).
export const splitItems = (rows: ItemRow[]): ContractLines => {
  const [included, excluded] = pipe(
    uniqBy((r: ItemRow) => String(r.record_id)),
    sortWith([ascend((r: ItemRow) => Number(r.record_id))]),
    partition((r: ItemRow) => r.is_included)
  )(rows)
  return { offered: map(toLine, included), asked: map(toLine, excluded) }
}

export type StatusRow = { owner: ContractOwner; status: string; valid_from: string; valid_until: string }

export type StatusStep = { status: string; from: string; until: string }

// The chosen owner's status steps, oldest first.
export const statusHistory = (owner: ContractOwner, rows: StatusRow[]): StatusStep[] =>
  pipe(
    filter((r: StatusRow) => ownerKey(r.owner) === ownerKey(owner)),
    sortWith([ascend(prop('valid_from'))]),
    map((r: StatusRow): StatusStep => ({ status: r.status, from: r.valid_from, until: r.valid_until }))
  )(rows)

// Distinct positive ids, in order, from nullable id columns.
const positiveIds: (values: Array<Num | null>) => number[] = pipe(
  filter((v: Num | null): v is Num => v != null),
  map(Number),
  filter((n: number) => Number.isSafeInteger(n) && n > 0),
  uniqBy(String)
)

// The ids that need a name: the parties of the contract.
export const partyIds = (row: ContractRow): number[] =>
  positiveIds([row.issuer_id, row.issuer_corporation_id, row.assignee_id, row.acceptor_id])

// The location ids that need a name. A courier has an end location too.
export const locationIds = (row: ContractRow): number[] => positiveIds([row.start_location_id, row.end_location_id])

const TYPE_LABELS: Record<string, string> = {
  item_exchange: 'Item exchange',
  auction: 'Auction',
  courier: 'Courier',
  loan: 'Loan',
  unknown: 'Unknown',
}

const STATUS_LABELS: Record<string, string> = {
  outstanding: 'Outstanding',
  in_progress: 'In progress',
  finished_issuer: 'Finished (issuer)',
  finished_contractor: 'Finished (contractor)',
  finished: 'Finished',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  failed: 'Failed',
  deleted: 'Deleted',
  reversed: 'Reversed',
}

// ESI keeps these enums open, so an unknown value shows as it is, with its
// underscores as spaces.
const labelFrom =
  (labels: Record<string, string>) =>
  (value: string | null): string =>
    value == null ? '—' : (labels[value] ?? value.replaceAll('_', ' '))

export const typeLabel = labelFrom(TYPE_LABELS)
export const statusLabel = labelFrom(STATUS_LABELS)
export const availabilityLabel = labelFrom({
  public: 'Public',
  personal: 'Private',
  corporation: 'Corporation',
  alliance: 'Alliance',
})

// The heading: the title when the issuer gave one, else the type and the id.
export const contractHeading = (row: ContractRow): string =>
  row.title != null && row.title.trim() !== '' ? row.title.trim() : `${typeLabel(row.type)} ${row.contract_id}`

const iskOrNull = (v: Num | null): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export type MoneyLine = { label: string; isk: number }

// The ISK columns that mean something for this type of contract, the zero
// ones left out. A courier has a reward and a collateral; an exchange a price
// and maybe a reward; an auction a starting bid and maybe a buyout.
export const moneyLines = (row: ContractRow): MoneyLine[] => {
  const lines: Array<[string, Num | null]> =
    row.type === 'courier'
      ? [
          ['Reward', row.reward],
          ['Collateral', row.collateral],
        ]
      : row.type === 'auction'
        ? [
            ['Starting bid', row.price],
            ['Buyout', row.buyout],
          ]
        : row.type === 'loan'
          ? [
              ['Price', row.price],
              ['Reward', row.reward],
              ['Collateral', row.collateral],
            ]
          : [
              ['Price', row.price],
              ['Reward', row.reward],
            ]
  return pipe(
    map(([label, v]: [string, Num | null]) => ({ label, isk: iskOrNull(v) })),
    filter((l: { label: string; isk: number | null }): l is MoneyLine => l.isk !== null && l.isk !== 0)
  )(lines)
}
