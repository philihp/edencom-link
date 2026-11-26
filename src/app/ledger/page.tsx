// /ledger — ledger stage 2 (docs/ledger/stage-2.md): the cash P&L by UTC month
// for the caller's group or one wallet, with the Suspense list and whether
// each month is proven. Chancellor only, and dark behind the `ledger` flag,
// as /ledger/health is. Everything is read on the cookie session, so RLS and
// the security-invoker functions keep it to the caller's own wallets.
//
// The statement is ledger_cash_statement() (PR A). Until that function exists,
// or when it answers anything that is not the contract's JSON, the page fails
// closed: it says the statement is not available and draws no figure. The
// fold is the pure src/ledger/statement.ts.
import { notFound, redirect } from 'next/navigation'
import { uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { ledgerEnabled } from '../../ledger/flag'
import { formatCents } from '../../ledger/money'
import {
  type Account,
  type AccountRow,
  type GroupRow,
  type LedgerView,
  ledgerView,
  monthWindow,
  parseStatement,
  pickerWallets,
  REASON_TEXT,
  type SegmentWallet,
  scopeOf,
  SUSPENSE_CODE,
  windowMonths,
} from '../../ledger/statement'
import { establishedUser } from '../account/lib/establishedUser'
import { isChancellor } from '../account/settings/chancellor/chancellor'
import { formatIskValue } from '../isk'
import retro from '../retro.module.css'
import { LedgerControls, type WalletOption } from './controls'

export const dynamic = 'force-dynamic'

type LedgerParams = { searchParams: Promise<{ months?: string; wallet?: string }> }

const isk = (cents: bigint): string => formatIskValue(formatCents(cents))
const percent = (share: number): string =>
  `${(share * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`

const walletLabel = (w: SegmentWallet, characters: Map<string, string>, corps: Map<string, string>): string =>
  w.registration_id !== null
    ? (characters.get(w.registration_id) ?? 'a character')
    : `${corps.get(String(w.corporation_id)) ?? `corporation #${w.corporation_id}`}, division ${w.division}`

const Row = ({
  row,
  strong = false,
}: {
  row: Pick<AccountRow, 'code' | 'name' | 'byMonth' | 'total'>
  strong?: boolean
}) => (
  <tr>
    <td>{strong ? <strong>{row.name}</strong> : row.name}</td>
    {row.byMonth.map((v, i) => (
      <td key={i} className={retro.num}>
        {isk(v)}
      </td>
    ))}
    <td className={retro.num}>{isk(row.total)}</td>
  </tr>
)

const total = (name: string, byMonth: bigint[]) => ({
  code: name,
  name,
  byMonth,
  total: byMonth.reduce((a, b) => a + b, 0n),
})

const Head = ({ months }: { months: string[] }) => (
  <thead>
    <tr>
      <th>Account</th>
      {months.map((m) => (
        <th key={m} className={retro.num}>
          {m}
        </th>
      ))}
      <th className={retro.num}>Window</th>
    </tr>
  </thead>
)

const ProfitAndLoss = ({ view }: { view: LedgerView }) => (
  <table className={retro.retro}>
    <Head months={view.months} />
    <tbody>
      {view.revenue.map((r) => (
        <Row key={r.code} row={r} />
      ))}
      <Row row={total('Revenue', view.revenueTotal)} strong />
      {view.expense.map((r) => (
        <Row key={r.code} row={r} />
      ))}
      <Row row={total('Expense', view.expenseTotal)} strong />
      <Row row={total('Net result', view.net)} strong />
      <tr>
        <td>Proven</td>
        {view.status.map((s) => (
          <td key={s.month} className={retro.num}>
            {s.proven ? 'proven' : 'not proven'}
          </td>
        ))}
        <td className={retro.num}>{view.allProven ? 'proven' : 'not proven'}</td>
      </tr>
    </tbody>
  </table>
)

const OtherLines = ({ view }: { view: LedgerView }) => (
  <table className={retro.retro}>
    <Head months={view.months} />
    <tbody>
      {view.other.map((r) => (
        <Row key={r.code} row={r} />
      ))}
      <Row row={total('Cash change', view.cash)} strong />
    </tbody>
  </table>
)

const Months = ({ view }: { view: LedgerView }) => (
  <table className={retro.retro}>
    <thead>
      <tr>
        <th>Month</th>
        <th>State</th>
        <th className={retro.num}>ISK moved</th>
        <th className={retro.num}>Suspense</th>
        <th className={retro.num}>Internal rows</th>
        <th className={retro.num}>Internal ISK</th>
        <th className={retro.num}>Unpaired</th>
      </tr>
    </thead>
    <tbody>
      {view.status.map((s) => (
        <tr key={s.month}>
          <td>{s.month}</td>
          <td>
            {!s.present
              ? 'not proven: no rows'
              : s.proven
                ? 'proven'
                : `not proven: ${s.reasons.map((r) => REASON_TEXT[r]).join('; ') || 'no reason given'}`}
          </td>
          <td className={retro.num}>{isk(s.iskMoved)}</td>
          <td className={retro.num}>{percent(s.suspenseShare)}</td>
          <td className={retro.num}>{s.internalRows.toLocaleString()}</td>
          <td className={retro.num}>{isk(s.internalIsk)}</td>
          <td className={retro.num}>{s.unpairedTransfers.toLocaleString()}</td>
        </tr>
      ))}
    </tbody>
  </table>
)

const SuspenseList = ({ view }: { view: LedgerView }) => (
  <>
    <p>
      {isk(view.suspenseIsk)} ISK of {isk(view.iskMoved)} ISK moved ({percent(view.suspenseShare)}) is on account{' '}
      {SUSPENSE_CODE}: rows whose <code>ref_type</code> has no account yet.
    </p>
    {view.suspense.length > 0 && (
      <table className={retro.retro}>
        <thead>
          <tr>
            <th>
              <code>ref_type</code>
            </th>
            <th className={retro.num}>Rows</th>
            <th className={retro.num}>ISK in</th>
            <th className={retro.num}>ISK out</th>
          </tr>
        </thead>
        <tbody>
          {view.suspense.map((s) => (
            <tr key={s.refType}>
              <td>
                <code>{s.refType}</code>
              </td>
              <td className={retro.num}>{s.rows.toLocaleString()}</td>
              <td className={retro.num}>{isk(s.iskIn)}</td>
              <td className={retro.num}>{isk(s.iskOut)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </>
)

const NotAvailable = () => (
  <p>
    The ledger statement is not available. The database does not have the cash ledger yet, or it gave an answer this
    page cannot read. No figure is shown.
  </p>
)

const LedgerPage = async ({ searchParams }: LedgerParams) => {
  if (!(await ledgerEnabled())) notFound()
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/account/login')
  if (!(await isChancellor(user.id))) notFound()

  const params = await searchParams
  const months = windowMonths(params.months)
  const window = monthWindow(new Date(), months)

  const [group, segments, accounts, registrations] = await Promise.all([
    supabase.rpc('ledger_group'),
    supabase
      .from('ledger_wallet_segment')
      .select('wallet_key, registration_id, corporation_id, division')
      .order('wallet_key')
      .limit(5000),
    supabase.from('ledger_account').select('code, name, kind'),
    supabase.from('registration').select('id, name'),
  ])
  const wallets =
    group.error || segments.error
      ? []
      : pickerWallets((group.data ?? []) as GroupRow[], (segments.data ?? []) as SegmentWallet[])
  const { scope, walletKey } = scopeOf(params.wallet, wallets)

  // Only asked when the group and the chart could be read: a database without
  // PR A has neither, and the page then fails closed without a third error.
  const statement =
    group.error || accounts.error
      ? null
      : await supabase
          .rpc('ledger_cash_statement', {
            p_from: window.from,
            p_to: window.to,
            p_scope: scope,
            p_wallet_key: walletKey,
          })
          .then(({ data, error }) => (error ? null : parseStatement(data)))
  const view = statement === null ? null : ledgerView(statement, (accounts.data ?? []) as Account[])

  const corpIds = uniq(wallets.flatMap((w) => (w.corporation_id === null ? [] : [w.corporation_id])))
  const { data: corpRows } = corpIds.length
    ? await supabase.from('corporation').select('corporation_id, name').in('corporation_id', corpIds)
    : { data: [] }
  const characters = new Map((registrations.data ?? []).map((r) => [String(r.id), String(r.name)]))
  const corps = new Map((corpRows ?? []).map((c) => [String(c.corporation_id), String(c.name ?? '')]))
  const options: WalletOption[] = wallets.map((w) => ({ key: w.wallet_key, label: walletLabel(w, characters, corps) }))

  return (
    <main>
      <h1>Ledger</h1>
      <LedgerControls months={months} wallet={walletKey} wallets={options} />
      <p>
        Cash in and out of the wallet journals, by UTC month, from {window.from} up to {window.to}. Income shows
        positive and cost negative. {scope === 'group' ? 'Transfers between wallets of the group are left out.' : ''} A
        month is proven when each wallet&apos;s journal is complete through it, its newest check is ok, and every
        internal transfer has its other side.
      </p>
      {view === null ? (
        <NotAvailable />
      ) : (
        <>
          <h2>Profit and loss</h2>
          {view.revenue.length + view.expense.length === 0 ? (
            <p>No revenue or expense in this window.</p>
          ) : (
            <ProfitAndLoss view={view} />
          )}
          <h2>Months</h2>
          <Months view={view} />
          <h2>Suspense</h2>
          <SuspenseList view={view} />
          <h2>Other lines</h2>
          <p>
            The rest of each journal row: escrow, inventory, intercompany and Suspense. With the P&amp;L they sum to the
            cash change.
          </p>
          <OtherLines view={view} />
          {statement !== null && statement.unpaired.length > 0 && (
            <>
              <h2>Unpaired internal transfers</h2>
              <p>
                A transfer between two wallets of the group with no row of the opposite amount in the other wallet. A
                month with one is not proven. At most 100 are listed.
              </p>
              <table className={retro.retro}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Wallet</th>
                    <th>
                      <code>ref_type</code>
                    </th>
                    <th className={retro.num}>Cash ISK</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.unpaired.map((u, i) => (
                    <tr key={i}>
                      <td>{u.date}</td>
                      <td>{options.find((o) => o.key === u.wallet_key)?.label ?? u.wallet_key}</td>
                      <td>
                        <code>{u.ref_type}</code>
                      </td>
                      <td className={retro.num}>{formatIskValue(u.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </main>
  )
}

export default LedgerPage
