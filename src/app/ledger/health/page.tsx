// /ledger/health — ledger stage 1 (docs/ledger/stage-1.md): each of the
// caller's wallets with its proven spans, the gaps between them and its newest
// check. Chancellor only, and dark behind the `ledger` flag: with the flag off
// the page does not exist (404). Everything is read on the cookie session, so
// RLS keeps it to the caller's own registrations and corporations. The fold is
// the pure src/ledger/health.ts.
import { notFound, redirect } from 'next/navigation'
import { uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { ledgerEnabled } from '../../../ledger/flag'
import { type CheckRow, type SegmentRow, type WalletHealth, walletHealth } from '../../../ledger/health'
import { establishedUser } from '../../account/lib/establishedUser'
import { isChancellor } from '../../account/settings/chancellor/chancellor'
import { DateTime } from '../../DateTime'
import { formatIskValue } from '../../isk'
import retro from '../../retro.module.css'

export const dynamic = 'force-dynamic'

// A day of checks per wallet is one row; 60 days back is plenty for "newest".
const CHECK_DAYS = 60

const SEGMENT_COLUMNS =
  'wallet_key, registration_id, corporation_id, division, first_entry_id, last_entry_id, first_date, last_date, opening, closing, row_count, rounding_steps'
const CHECK_COLUMNS =
  'wallet_key, registration_id, corporation_id, division, checked_at, ok, segments, new_breaks, snapshot_compare, snapshot_difference, last_pull_at, reasons'

const walletName = (w: WalletHealth, characters: Map<string, string>, corps: Map<string, string>): string =>
  w.registrationId !== null
    ? (characters.get(w.registrationId) ?? 'a character')
    : `${corps.get(String(w.corporationId)) ?? `corporation #${w.corporationId}`}, division ${w.division}`

const Wallet = ({ wallet, name }: { wallet: WalletHealth; name: string }) => (
  <section>
    <h3>
      {name}: {wallet.latest === null ? 'not checked yet' : wallet.latest.ok ? 'ok' : 'FAILS'}
    </h3>
    <p>
      {wallet.rows.toLocaleString()} rows in {wallet.segments.length} proven span
      {wallet.segments.length === 1 ? '' : 's'}, {wallet.roundingSteps.toLocaleString()} one-cent steps.
      {wallet.latest !== null && (
        <>
          {' '}
          Checked <DateTime value={wallet.latest.checked_at} />; newest pull{' '}
          <DateTime value={wallet.latest.last_pull_at} fallback="none" />; snapshot{' '}
          {wallet.latest.snapshot_compare ?? 'none'}
          {wallet.latest.snapshot_difference !== null && ` (${formatIskValue(wallet.latest.snapshot_difference)})`}.
        </>
      )}
    </p>
    {wallet.latest !== null && wallet.latest.reasons.length > 0 && (
      <ul>
        {wallet.latest.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    )}
    {wallet.gaps.length > 0 && (
      <table className={retro.retro}>
        <thead>
          <tr>
            <th>Gap after entry</th>
            <th>Before entry</th>
            <th>From</th>
            <th>To</th>
            <th className={retro.num}>Missing ISK</th>
          </tr>
        </thead>
        <tbody>
          {wallet.gaps.map((g) => (
            <tr key={g.atEntryId}>
              <td>{g.afterEntryId}</td>
              <td>{g.atEntryId}</td>
              <td>
                <DateTime value={g.from} />
              </td>
              <td>
                <DateTime value={g.to} />
              </td>
              <td className={retro.num}>{formatIskValue(g.missing)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </section>
)

const LedgerHealthPage = async () => {
  if (!(await ledgerEnabled())) notFound()
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/account/login')
  if (!(await isChancellor(user.id))) notFound()

  const since = new Date(Date.now() - CHECK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const [segments, checks, registrations] = await Promise.all([
    supabase.from('ledger_wallet_segment').select(SEGMENT_COLUMNS).order('first_entry_id').limit(5000),
    supabase
      .from('ledger_check')
      .select(CHECK_COLUMNS)
      .gte('checked_at', since)
      .order('checked_at', { ascending: false })
      .limit(5000),
    supabase.from('registration').select('id, name'),
  ])
  if (segments.error) throw segments.error
  if (checks.error) throw checks.error
  const wallets = walletHealth((segments.data ?? []) as SegmentRow[], (checks.data ?? []) as CheckRow[])

  const corpIds = uniq(wallets.flatMap((w) => (w.corporationId === null ? [] : [w.corporationId])))
  const { data: corpRows } = corpIds.length
    ? await supabase.from('corporation').select('corporation_id, name').in('corporation_id', corpIds)
    : { data: [] }
  const characters = new Map((registrations.data ?? []).map((r) => [String(r.id), String(r.name)]))
  const corps = new Map((corpRows ?? []).map((c) => [String(c.corporation_id), String(c.name ?? '')]))

  return (
    <main>
      <h1>Ledger health</h1>
      <p>
        A proven span is a run of journal rows where each balance equals the balance before plus the amount. A gap
        between two spans is rows that are not in the journal. A wallet fails on a new gap, a balance snapshot that
        differs from the journal, or no journal pull in 7 days.
      </p>
      {wallets.length === 0 ? (
        <p>No wallet is checked yet. The ledger-check job has not run.</p>
      ) : (
        wallets.map((w) => <Wallet key={w.walletKey} wallet={w} name={walletName(w, characters, corps)} />)
      )}
    </main>
  )
}

export default LedgerHealthPage
