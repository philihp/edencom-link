// The /ledger read fold (docs/ledger/stage-2.md, "The statement"): from the
// JSON of ledger_cash_statement() to the rows the page draws. Pure: no I/O.
//
// The statement gives the `other` side of each journal row, summed by account
// and month. Debit is positive, so revenue is negative and expense positive.
// The P&L turns the sign for display: income shows positive, cost negative,
// and the net result is the negative of the sum of the revenue and expense
// lines. Every amount is integer cents (src/ledger/money.ts), never a float.
import { ascend, identity, isNil, prop, sortBy, sortWith, sum, uniq, uniqBy } from 'ramda'

import { toCents } from './money.ts'

// ---------------------------------------------------------------------------
// The contract: the JSON as stage-2.md defines it.

export type StatementWallet = {
  wallet_key: string
  kind: 'character' | 'corporation'
  registration_id: string | null
  corporation_id: number | null
  division: number | null
}

export type StatementLine = { account_code: string; amount: string; rows: number }

export type NotProvenReason = 'break' | 'check_failed' | 'no_check' | 'unpaired_transfer'

export type StatementMonth = {
  month: string
  lines: StatementLine[]
  isk_moved: string
  suspense_isk: string
  internal_rows: number
  internal_isk: string
  unpaired_transfers: number
  proven: boolean
  not_proven: NotProvenReason[]
}

export type StatementSuspense = { ref_type: string; rows: number; isk_in: string; isk_out: string }

export type StatementUnpaired = {
  date: string
  wallet_key: string
  ref_type: string
  amount: string
  other_party_id: number
}

export type Statement = {
  window: { from: string; to: string }
  scope: 'group' | 'wallet'
  wallets: StatementWallet[]
  months: StatementMonth[]
  suspense: StatementSuspense[]
  unpaired: StatementUnpaired[]
}

// A row of ledger_account (the seeded chart).
export type Account = { code: string; name: string; kind: AccountKind }
export type AccountKind = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

export const SUSPENSE_CODE = '9000'

// ---------------------------------------------------------------------------
// Parse. The RPC answers json; a value that is not the contract's shape is a
// fault, and the page shows "not available" rather than a wrong table.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isAmount = (v: unknown): boolean => {
  try {
    return (typeof v === 'string' || typeof v === 'number') && toCents(v) !== null
  } catch {
    return false
  }
}
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const REASONS: readonly string[] = ['break', 'check_failed', 'no_check', 'unpaired_transfer']

const isLine = (v: unknown): boolean => isObject(v) && isText(v.account_code) && isAmount(v.amount) && isCount(v.rows)

const isMonth = (v: unknown): boolean =>
  isObject(v) &&
  isText(v.month) &&
  MONTH.test(v.month) &&
  Array.isArray(v.lines) &&
  v.lines.every(isLine) &&
  isAmount(v.isk_moved) &&
  isAmount(v.suspense_isk) &&
  isCount(v.internal_rows) &&
  isAmount(v.internal_isk) &&
  isCount(v.unpaired_transfers) &&
  typeof v.proven === 'boolean' &&
  Array.isArray(v.not_proven) &&
  v.not_proven.every((r) => isText(r) && REASONS.includes(r))

const isWallet = (v: unknown): boolean =>
  isObject(v) && isText(v.wallet_key) && (v.kind === 'character' || v.kind === 'corporation')

const isSuspense = (v: unknown): boolean =>
  isObject(v) && isText(v.ref_type) && isCount(v.rows) && isAmount(v.isk_in) && isAmount(v.isk_out)

const isUnpaired = (v: unknown): boolean =>
  isObject(v) && isText(v.date) && isText(v.wallet_key) && isText(v.ref_type) && isAmount(v.amount)

// The statement, or null when the value is not one.
export const parseStatement = (v: unknown): Statement | null =>
  isObject(v) &&
  isObject(v.window) &&
  isText(v.window.from) &&
  DAY.test(v.window.from) &&
  isText(v.window.to) &&
  DAY.test(v.window.to) &&
  (v.scope === 'group' || v.scope === 'wallet') &&
  Array.isArray(v.wallets) &&
  v.wallets.every(isWallet) &&
  Array.isArray(v.months) &&
  v.months.every(isMonth) &&
  Array.isArray(v.suspense) &&
  v.suspense.every(isSuspense) &&
  Array.isArray(v.unpaired) &&
  v.unpaired.every(isUnpaired)
    ? (v as unknown as Statement)
    : null

// ---------------------------------------------------------------------------
// The window: the trailing N UTC months, this month included. `to` is the
// first day of next month (excluded), so 12 months is at most 366 days (C2).

export const MONTH_WINDOW_OPTIONS: readonly number[] = [1, 3, 6, 12]
export const DEFAULT_MONTHS = 3

export const windowMonths = (raw: unknown): number => {
  const n = Number(raw)
  return MONTH_WINDOW_OPTIONS.includes(n) ? n : DEFAULT_MONTHS
}

const firstOfMonth = (year: number, month: number): string =>
  new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)

export const monthWindow = (now: Date, months: number): { from: string; to: string } => ({
  from: firstOfMonth(now.getUTCFullYear(), now.getUTCMonth() - (months - 1)),
  to: firstOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1),
})

// The months of the window as 'YYYY-MM', oldest first, so a month with no
// rows still has a column.
export const monthsOf = (window: { from: string; to: string }): string[] => {
  const [fy, fm] = window.from.split('-').map(Number)
  const [ty, tm] = window.to.split('-').map(Number)
  const count = (ty - fy) * 12 + (tm - fm)
  return Array.from({ length: Math.max(0, count) }, (_, i) => firstOfMonth(fy, fm - 1 + i).slice(0, 7))
}

// ---------------------------------------------------------------------------
// The fold.

export type AccountRow = {
  code: string
  name: string
  kind: AccountKind | 'unknown'
  // Cents for display, one per month of `months`. In the P&L the sign is
  // turned (income positive); below the P&L it is the debit as stored.
  byMonth: bigint[]
  total: bigint
  rows: number
}

export type MonthStatus = {
  month: string
  proven: boolean
  reasons: NotProvenReason[]
  iskMoved: bigint
  suspenseIsk: bigint
  // Suspense ISK over ISK moved, 0 when nothing moved.
  suspenseShare: number
  internalRows: number
  internalIsk: bigint
  unpairedTransfers: number
  present: boolean
}

export type SuspenseRow = { refType: string; rows: number; iskIn: bigint; iskOut: bigint }

export type LedgerView = {
  months: string[]
  revenue: AccountRow[]
  expense: AccountRow[]
  revenueTotal: bigint[]
  expenseTotal: bigint[]
  // Net result per month and over the window (income positive).
  net: bigint[]
  netTotal: bigint
  // The other lines that are not in the P&L: escrow, inventory, intercompany,
  // suspense, and any code the chart does not know. Debit positive.
  other: AccountRow[]
  // The cash side per month: the negative of the sum of every other line.
  cash: bigint[]
  status: MonthStatus[]
  allProven: boolean
  suspense: SuspenseRow[]
  suspenseIsk: bigint
  iskMoved: bigint
  suspenseShare: number
}

const cents = (v: string | number): bigint => toCents(v) ?? 0n
const neg = (v: bigint): bigint => -v
const sumCents = (vs: readonly bigint[]): bigint => vs.reduce((a, b) => a + b, 0n)
const share = (part: bigint, whole: bigint): number => (whole === 0n ? 0 : Number(part) / Number(whole))

// The kind of a code the chart does not list. The seed's first digit says it
// (design.md): 4 is revenue, 5 expense; anything else stays out of the P&L.
const kindOf = (accounts: Map<string, Account>, code: string): AccountRow['kind'] =>
  accounts.get(code)?.kind ?? 'unknown'

const byIskDescending = (a: SuspenseRow, b: SuspenseRow): number => {
  const [x, y] = [a.iskIn + a.iskOut, b.iskIn + b.iskOut]
  return x === y ? 0 : x > y ? -1 : 1
}

type Flat = { month: string; code: string; amount: bigint; rows: number }

const accountRows = (
  months: readonly string[],
  flat: readonly Flat[],
  accounts: Map<string, Account>,
  display: (v: bigint) => bigint
): AccountRow[] =>
  sortBy(identity, uniq(flat.map((f) => f.code))).map((code): AccountRow => {
    const lines = flat.filter((f) => f.code === code)
    const byMonth = months.map((m) => display(sumCents(lines.filter((l) => l.month === m).map((l) => l.amount))))
    return {
      code,
      name: accounts.get(code)?.name ?? `Account ${code}`,
      kind: kindOf(accounts, code),
      byMonth,
      total: sumCents(byMonth),
      rows: sum(lines.map((l) => l.rows)),
    }
  })

const columnTotals = (months: readonly string[], rows: readonly AccountRow[]): bigint[] =>
  months.map((_, i) => sumCents(rows.map((r) => r.byMonth[i])))

const statusOf = (month: string, m: StatementMonth | undefined): MonthStatus =>
  isNil(m)
    ? {
        month,
        proven: false,
        reasons: [],
        iskMoved: 0n,
        suspenseIsk: 0n,
        suspenseShare: 0,
        internalRows: 0,
        internalIsk: 0n,
        unpairedTransfers: 0,
        present: false,
      }
    : {
        month,
        proven: m.proven,
        reasons: uniq(m.not_proven),
        iskMoved: cents(m.isk_moved),
        suspenseIsk: cents(m.suspense_isk),
        suspenseShare: share(cents(m.suspense_isk), cents(m.isk_moved)),
        internalRows: m.internal_rows,
        internalIsk: cents(m.internal_isk),
        unpairedTransfers: m.unpaired_transfers,
        present: true,
      }

export const ledgerView = (statement: Statement, chart: readonly Account[]): LedgerView => {
  const accounts = new Map(chart.map((a) => [a.code, a]))
  const months = monthsOf(statement.window)
  const flat: Flat[] = statement.months.flatMap((m) =>
    m.lines.map((l) => ({ month: m.month, code: l.account_code, amount: cents(l.amount), rows: l.rows }))
  )
  const inPnl = (kind: AccountRow['kind']) => kind === 'revenue' || kind === 'expense'
  const pnl = accountRows(
    months,
    flat.filter((f) => inPnl(kindOf(accounts, f.code))),
    accounts,
    neg
  )
  const revenue = pnl.filter((r) => r.kind === 'revenue')
  const expense = pnl.filter((r) => r.kind === 'expense')
  const other = accountRows(
    months,
    flat.filter((f) => !inPnl(kindOf(accounts, f.code))),
    accounts,
    (v) => v
  )
  const revenueTotal = columnTotals(months, revenue)
  const expenseTotal = columnTotals(months, expense)
  const net = months.map((_, i) => revenueTotal[i] + expenseTotal[i])
  const otherTotal = columnTotals(months, other)
  // Cash is the negative of every other line; the P&L lines are stored
  // negated, so they add back with their display sign.
  const cash = months.map((_, i) => net[i] - otherTotal[i])
  const byMonth = new Map(statement.months.map((m) => [m.month, m]))
  const status = months.map((m) => statusOf(m, byMonth.get(m)))
  const suspenseIsk = sumCents(status.map((s) => s.suspenseIsk))
  const iskMoved = sumCents(status.map((s) => s.iskMoved))
  return {
    months,
    revenue,
    expense,
    revenueTotal,
    expenseTotal,
    net,
    netTotal: sumCents(net),
    other,
    cash,
    status,
    allProven: status.every((s) => s.proven),
    // Largest ISK first, then by name, so the order is stable.
    suspense: sortWith<SuspenseRow>([byIskDescending, ascend(prop('refType'))])(
      statement.suspense.map((s) => ({
        refType: s.ref_type,
        rows: s.rows,
        iskIn: cents(s.isk_in),
        iskOut: cents(s.isk_out),
      }))
    ),
    suspenseIsk,
    iskMoved,
    suspenseShare: share(suspenseIsk, iskMoved),
  }
}

// ---------------------------------------------------------------------------
// The wallet picker: every wallet the stage 1 check has a segment for, kept
// to the caller's group (ledger_group()). A corporation the caller is only a
// member of is not in the group (I-11), so its divisions are not offered.

export type GroupRow = { registration_id: string | null; character_id?: number | null; corporation_id: number | null }
export type SegmentWallet = {
  wallet_key: string
  registration_id: string | null
  corporation_id: number | null
  division: number | null
}

export const pickerWallets = (group: readonly GroupRow[], segments: readonly SegmentWallet[]): SegmentWallet[] => {
  const registrations = new Set(group.flatMap((g) => (isNil(g.registration_id) ? [] : [g.registration_id])))
  const corporations = new Set(group.flatMap((g) => (isNil(g.corporation_id) ? [] : [Number(g.corporation_id)])))
  return sortWith<SegmentWallet>([
    ascend((w) => (w.registration_id === null ? 1 : 0)),
    ascend((w) => w.registration_id ?? ''),
    ascend((w) => w.corporation_id ?? 0),
    ascend((w) => w.division ?? 0),
  ])(
    uniqBy(
      prop('wallet_key'),
      segments.filter((w) =>
        w.registration_id !== null
          ? registrations.has(w.registration_id)
          : w.corporation_id !== null && corporations.has(Number(w.corporation_id))
      )
    )
  )
}

// `?wallet=` back to a scope: a key the picker offers is that one wallet,
// anything else is the group.
export const scopeOf = (
  raw: unknown,
  wallets: readonly SegmentWallet[]
): { scope: 'group'; walletKey: null } | { scope: 'wallet'; walletKey: string } =>
  typeof raw === 'string' && wallets.some((w) => w.wallet_key === raw)
    ? { scope: 'wallet', walletKey: raw }
    : { scope: 'group', walletKey: null }

// Why a month is not proven, in words for the page.
export const REASON_TEXT: Record<NotProvenReason, string> = {
  break: 'a journal break inside the month',
  check_failed: 'the newest check of a wallet failed',
  no_check: 'a wallet has no check',
  unpaired_transfer: 'an internal transfer has no row on the other side (see Unpaired internal transfers)',
}
