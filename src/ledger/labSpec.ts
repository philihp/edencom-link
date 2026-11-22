// What the ledger lab copy reads from production, and how it pages
// (docs/ledger/plan.md, stage 0 step 1; docs/ledger/lab.md).
//
// The copy is for ONE account. Each table is read in PARTITIONS, one per
// owner (a registration, a corporation, or a corporation wallet division),
// so that each page is an index range scan on the table's primary key: the
// equality on the owner, then the KEYSET `key > last key seen`, in key order,
// 1,000 rows at a time. No page is an OFFSET, and no page reads rows it does
// not return. That keeps the load on production small and flat.
//
// The wallet tables are copied as typed columns, because the census does
// arithmetic on them. The contract and industry job tables are copied as one
// JSON document per row: the census does not read them, and stage 3 decides
// which columns it needs.
import { chain, map, range } from 'ramda'

export type Owners = { registrationIds: readonly string[]; corporationIds: readonly number[] }

// 'owner' is a table that holds rows of both kinds of wallet (the ledger
// tables): one partition for each registration, then one for each corporation.
export type PartitionKind = 'registration' | 'corporation' | 'corporation-division' | 'owner'

export type TableSpec = {
  table: string
  // The columns to copy, or 'raw' for the whole row as one JSON document.
  columns: readonly string[] | 'raw'
  partition: PartitionKind
  // Keyset order inside a partition. One key, or two (lexical order).
  keys: readonly string[]
}

export type Partition = Readonly<Record<string, string | number>>

// The columns of the two journals. `reason` and `description` are left out:
// the census does not need free text, and the lab then holds less of it.
const JOURNAL = [
  'entry_id',
  'date',
  'ref_type',
  'amount',
  'balance',
  'first_party_id',
  'second_party_id',
  'context_id',
  'context_id_type',
  'tax',
  'tax_receiver_id',
  'seen_at',
]

const TRANSACTION = [
  'transaction_id',
  'registration_id',
  'date',
  'type_id',
  'quantity',
  'unit_price',
  'is_buy',
  'client_id',
  'location_id',
  'journal_ref_id',
  'seen_at',
]

const LEDGER_OWNER = ['id', 'registration_id', 'corporation_id', 'division']

const LEDGER_SEGMENT = [
  ...LEDGER_OWNER,
  'first_entry_id',
  'last_entry_id',
  'first_date',
  'last_date',
  'opening',
  'closing',
  'row_count',
  'rounding_steps',
  'hidden_credit_steps',
  'pending_credits',
  'computed_at',
]

const LEDGER_CHECK = [
  ...LEDGER_OWNER,
  'checked_at',
  'ok',
  'segments',
  'new_breaks',
  'rounding_steps',
  'hidden_credit_steps',
  'rows_read',
  'rebuilt',
  'newest_entry_id',
  'newest_entry_date',
  'last_pull_at',
  'snapshot_compare',
  'snapshot_difference',
  'reasons',
]

// The registration rows of the account: the first read, which finds the
// owners. Only the ids; no names.
export const REGISTRATION_COLUMNS = ['id', 'character_id', 'corporation_id', 'is_main'] as const

export const TABLES: readonly TableSpec[] = [
  {
    table: 'character_wallet',
    columns: ['id', 'registration_id', 'balance', 'recorded_at'],
    partition: 'registration',
    keys: ['id'],
  },
  {
    table: 'character_wallet_journal',
    columns: ['registration_id', ...JOURNAL],
    partition: 'registration',
    keys: ['entry_id'],
  },
  {
    table: 'corp_wallet_journal',
    columns: ['corporation_id', 'division', ...JOURNAL],
    partition: 'corporation-division',
    keys: ['entry_id'],
  },
  {
    table: 'character_wallet_transaction',
    columns: [...TRANSACTION, 'is_personal'],
    partition: 'registration',
    keys: ['transaction_id'],
  },
  {
    table: 'corp_wallet_transaction',
    columns: [...TRANSACTION, 'corporation_id', 'division'],
    partition: 'registration',
    keys: ['transaction_id'],
  },
  { table: 'character_contract', columns: 'raw', partition: 'registration', keys: ['contract_id'] },
  { table: 'corp_contract', columns: 'raw', partition: 'corporation', keys: ['contract_id'] },
  { table: 'character_contract_item', columns: 'raw', partition: 'registration', keys: ['contract_id', 'record_id'] },
  { table: 'corp_contract_item', columns: 'raw', partition: 'corporation', keys: ['contract_id', 'record_id'] },
  { table: 'character_contract_status_over_time', columns: 'raw', partition: 'registration', keys: ['id'] },
  { table: 'corp_contract_status_over_time', columns: 'raw', partition: 'corporation', keys: ['id'] },
  { table: 'character_industry_job_over_time', columns: 'raw', partition: 'registration', keys: ['id'] },
  { table: 'corp_industry_job_over_time', columns: 'raw', partition: 'corporation', keys: ['id'] },
  // Stage 2 (docs/ledger/stage-2.md): the director proof of ledger_group(),
  // and the stage 1 evidence that a month is "proven" from.
  {
    table: 'corp_job_access',
    columns: ['registration_id', 'corporation_id', 'job', 'observed_at'],
    partition: 'registration',
    keys: ['corporation_id', 'job'],
  },
  { table: 'ledger_wallet_segment', columns: LEDGER_SEGMENT, partition: 'owner', keys: ['id'] },
  { table: 'ledger_check', columns: LEDGER_CHECK, partition: 'owner', keys: ['id'] },
]

// A corporation has seven wallet divisions, 1 to 7.
export const DIVISIONS = range(1, 8)

export const partitionsOf = (spec: TableSpec, { registrationIds, corporationIds }: Owners): Partition[] => {
  if (spec.partition === 'registration') return map((id) => ({ registration_id: id }), registrationIds)
  if (spec.partition === 'corporation') return map((id) => ({ corporation_id: id }), corporationIds)
  if (spec.partition === 'owner')
    return [
      ...map((id) => ({ registration_id: id }), registrationIds),
      ...map((id) => ({ corporation_id: id }), corporationIds),
    ]
  return chain((id) => map((division) => ({ corporation_id: id, division }), DIVISIONS), corporationIds)
}

// The file a table is written to, and the lab table it loads into.
export const csvColumnsOf = (spec: TableSpec): readonly string[] => (spec.columns === 'raw' ? ['doc'] : spec.columns)
export const labTableOf = (spec: TableSpec): string => (spec.columns === 'raw' ? `raw_${spec.table}` : spec.table)

// The select list sent to PostgREST.
export const selectOf = (spec: TableSpec): string => (spec.columns === 'raw' ? '*' : spec.columns.join(','))

// One row as the values of its CSV line.
export const valuesOf = (spec: TableSpec, row: Record<string, unknown>): Record<string, unknown> =>
  spec.columns === 'raw' ? { doc: row } : row

// The keyset filter for the page after `last`, as one of the two forms
// PostgREST takes: a `gt` on one key, or an `or` filter for two keys,
// `a > A or (a = A and b > B)`. Null for the first page.
export type Keyset = { gt: [string, string | number] } | { or: string } | null

export const keysetAfter = (keys: readonly string[], last: Record<string, unknown> | null): Keyset => {
  if (last === null) return null
  const [first, second] = keys
  if (second === undefined) return { gt: [first, last[first] as string | number] }
  const a = String(last[first])
  const b = String(last[second])
  return { or: `${first}.gt.${a},and(${first}.eq.${a},${second}.gt.${b})` }
}

// The psql script that loads a copy into the lab schema: one `\copy` for each
// file, registration first. `dir` is where src/ledger/labCopy.ts wrote them.
const sqlText = (text: string): string => `'${text.replace(/'/g, "''")}'`

const copyCommand = (dir: string, labTable: string, columns: readonly string[]): string =>
  `\\copy ledger_lab.${labTable} (${columns.join(', ')}) from ${sqlText(`${dir}/${labTable}.csv`)} with (format csv, header true)`

export const loadScript = (dir: string): string =>
  [
    '\\set ON_ERROR_STOP 1',
    copyCommand(dir, 'registration', REGISTRATION_COLUMNS),
    ...map((spec) => copyCommand(dir, labTableOf(spec), csvColumnsOf(spec)), TABLES),
    '',
  ].join('\n')
