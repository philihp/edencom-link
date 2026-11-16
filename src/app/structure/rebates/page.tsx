// /structure/rebates — per payer, the facility tax their industry jobs paid to
// our structures over the window, and the tax we have given back to them by
// contract. Everything is read on the cookie session, so RLS keeps it to the
// caller's own corporation journals and contracts. The fold is the pure
// rebates.ts.
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { map, splitEvery, uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'
import { formatIskValue } from '../../isk'
import { Name } from '../../names'
import { fetchAllRows } from '../../pager'
import retro from '../../retro.module.css'
import { timeWindowDays } from '../../timeWindow'
import { UrlWindowSelect } from '../../windowSelect'
import structureStyles from '../structures.module.css'
import { foldRebates, type RebateContract, rebateContracts, type TaxReceipt } from './rebates'
import styles from './rebates.module.css'

export const dynamic = 'force-dynamic'

const DEFAULT_DAYS = 30
const IN_CHUNK = 300

type Supabase = Awaited<ReturnType<typeof createClient>>

type JournalRow = TaxReceipt & {
  corporation_id: number | string
  division: number | string
  entry_id: number | string
}

const CONTRACT_COLUMNS =
  'contract_id, type, for_corporation, issuer_id, issuer_corporation_id, assignee_id, acceptor_id, price, reward, title, status, date_issued, date_expired, date_completed'

// The tax-titled ISK payments our characters and corporations issued. The
// fold does the exact test; this only narrows what comes over the wire.
const fetchTaxContracts = async (supabase: Supabase, view: string): Promise<RebateContract[]> =>
  fetchAllRows<RebateContract>(
    (from, to, count) =>
      supabase
        .from(view)
        .select(CONTRACT_COLUMNS, { count })
        .eq('type', 'item_exchange')
        .gt('reward', 0)
        .ilike('title', '%tax%')
        .order('contract_id')
        .range(from, to) as never,
    (c) => String(c.contract_id)
  )

const inChunks = async <T,>(ids: readonly string[], read: (chunk: string[]) => PromiseLike<T[]>): Promise<T[]> =>
  (await Promise.all(map(read, splitEvery(IN_CHUNK, [...ids])))).flat()

const fetchItemCounts = async (supabase: Supabase, contractIds: readonly string[]): Promise<Map<string, number>> => {
  const rows = await inChunks(contractIds, async (chunk) => {
    const [a, b] = await Promise.all(
      ['character_contract_item', 'corp_contract_item'].map((table) =>
        supabase.from(table).select('contract_id').in('contract_id', chunk)
      )
    )
    return [
      ...((a.data ?? []) as Array<{ contract_id: number | string }>),
      ...((b.data ?? []) as Array<{ contract_id: number | string }>),
    ]
  })
  // Both owner copies of one contract hold the same items, so a count above
  // zero is all the fold needs.
  return new Map(map((r) => [String(r.contract_id), 1] as [string, number], rows))
}

type PartyName = { name: string; type: 'character' | 'corporation' | null; registered: boolean }

// Names for payers: the world-readable character directory first (which also
// says whether the party is registered here), then the corporation table, then
// universe_name.
const fetchPartyNames = async (supabase: Supabase, ids: readonly string[]): Promise<Map<string, PartyName>> => {
  const names = new Map<string, PartyName>()
  if (ids.length === 0) return names
  const [directoryByCharacter, directoryByCorp, corporations, universe] = await Promise.all([
    inChunks(ids, async (chunk) => {
      const { data } = await supabase.from('character_directory').select('character_id, name').in('character_id', chunk)
      return (data ?? []) as Array<{ character_id: number | string; name: string }>
    }),
    inChunks(ids, async (chunk) => {
      const { data } = await supabase.from('character_directory').select('corporation_id').in('corporation_id', chunk)
      return (data ?? []) as Array<{ corporation_id: number | string }>
    }),
    inChunks(ids, async (chunk) => {
      const { data } = await supabase.from('corporation').select('corporation_id, name').in('corporation_id', chunk)
      return (data ?? []) as Array<{ corporation_id: number | string; name: string | null }>
    }),
    inChunks(ids, async (chunk) => {
      const { data } = await supabase.from('universe_name').select('id, name, category').in('id', chunk)
      return (data ?? []) as Array<{ id: number | string; name: string; category?: string | null }>
    }),
  ])
  const registeredCorps = new Set(map((r) => String(r.corporation_id), directoryByCorp))
  universe.forEach((u) =>
    names.set(String(u.id), {
      name: u.name,
      type: u.category === 'corporation' ? 'corporation' : u.category === 'character' ? 'character' : null,
      registered: registeredCorps.has(String(u.id)),
    })
  )
  corporations.forEach((c) =>
    names.set(String(c.corporation_id), {
      name: c.name ?? names.get(String(c.corporation_id))?.name ?? `#${c.corporation_id}`,
      type: 'corporation',
      registered: registeredCorps.has(String(c.corporation_id)),
    })
  )
  directoryByCharacter.forEach((d) =>
    names.set(String(d.character_id), { name: d.name, type: 'character', registered: true })
  )
  return names
}

type RebatesParams = {
  searchParams: Promise<{ days?: string }>
}

const RebatesPage = async ({ searchParams }: RebatesParams) => {
  const { days: daysParam } = await searchParams
  const days = timeWindowDays(daysParam, DEFAULT_DAYS)
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/')
  }

  const now = new Date()
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()

  const [{ data: registrations }, receipts, characterContracts, corpContracts] = await Promise.all([
    supabase.from('registration').select('character_id, corporation_id'),
    fetchAllRows<JournalRow>(
      (from, to, count) =>
        supabase
          .from('corp_wallet_journal')
          .select('corporation_id, division, entry_id, date, amount, context_id, first_party_id', { count })
          .eq('ref_type', 'industry_job_tax')
          .gt('amount', 0)
          .gte('date', since)
          .order('date', { ascending: false })
          .order('entry_id', { ascending: false })
          .range(from, to) as never,
      (r) => `${r.corporation_id}:${r.division}:${r.entry_id}`
    ),
    fetchTaxContracts(supabase, 'character_contract_with_status'),
    fetchTaxContracts(supabase, 'corp_contract_with_status'),
  ])

  const own = (registrations ?? []) as Array<{
    character_id: number | string | null
    corporation_id: number | string | null
  }>
  const ours = {
    characterIds: new Set(
      map(
        String,
        own.map((r) => r.character_id).filter((id) => id != null)
      )
    ),
    corporationIds: new Set(
      map(
        String,
        own.map((r) => r.corporation_id).filter((id) => id != null)
      )
    ),
  }
  const contracts = [...characterContracts, ...corpContracts]
  const candidateIds = uniq(
    map(
      (c) => String(c.contract_id),
      rebateContracts({ contracts, itemCounts: new Map(), ours, since, now: now.toISOString() })
    )
  )
  const itemCounts = await fetchItemCounts(supabase, candidateIds)
  const rows = foldRebates({ receipts, contracts, itemCounts, ours, since, now: now.toISOString() })

  const landlordIds = uniq(map((r) => String(r.corporation_id), receipts))
  const names = await fetchPartyNames(supabase, uniq([...map((r) => r.partyId, rows), ...landlordIds]))
  const landlords = map((id) => names.get(id)?.name ?? `#${id}`, landlordIds)

  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((total, r) => total + pick(r), 0)
  const totals = {
    paid: sum((r) => r.paid),
    jobs: sum((r) => r.jobs),
    rebated: sum((r) => r.rebated),
    pending: sum((r) => r.pending),
    net: sum((r) => r.net),
  }

  return (
    <>
      <div className={structureStyles.header}>
        <div>
          <h1 className={structureStyles.title}>tax rebates</h1>
          <div className={structureStyles.subtitle}>
            facility tax paid to {landlords.length > 0 ? landlords.join(', ') : 'our corporations'} · tax refunds paid
            back by contract
          </div>
        </div>
        <div className={structureStyles.headerRight}>
          <span className={structureStyles.headerLinks}>
            <Link href="/structure">&laquo; structures</Link>
            <Link href="/structure/revenue">tax revenue events &raquo;</Link>
          </span>
          <span className={structureStyles.headerControl}>
            <span className={structureStyles.headerControlLabel}>window</span>
            <UrlWindowSelect days={days} path="/structure/rebates" />
          </span>
        </div>
      </div>
      <p className={styles.note}>
        <strong>Tax paid</strong> is the industry job tax our corporation wallets received from each payer in the
        window. A job installed as a corporation is paid by that corporation. <strong>Rebated</strong> counts the
        contracts we issued that pay only ISK (no items, no price) with &ldquo;tax&rdquo; and &ldquo;refund&rdquo; or
        &ldquo;rebate&rdquo; in the title, completed in the window. <strong>Pending</strong> is such contracts still
        open.
      </p>
      {rows.length > 0 ? (
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>Payer</th>
              <th>Type</th>
              <th>Edencom</th>
              <th className={retro.num}>Jobs</th>
              <th className={retro.num}>Tax paid (ISK)</th>
              <th className={retro.num}>Rebated (ISK)</th>
              <th className={retro.num}>Pending (ISK)</th>
              <th className={retro.num}>Net (ISK)</th>
            </tr>
          </thead>
          <tbody>
            {map((r) => {
              const party = names.get(r.partyId)
              return (
                <tr key={r.partyId}>
                  <td>
                    <Name name={party?.name} id={r.partyId} />
                  </td>
                  <td>{party?.type ?? '—'}</td>
                  <td>{party?.registered ? 'yes' : '—'}</td>
                  <td className={retro.num}>{r.jobs}</td>
                  <td className={retro.num}>{formatIskValue(r.paid)}</td>
                  <td className={retro.num}>
                    {r.rebated > 0 ? formatIskValue(r.rebated) : '—'}
                    {r.rebates > 1 && <span className={styles.count}> ×{r.rebates}</span>}
                  </td>
                  <td className={retro.num}>{r.pending > 0 ? formatIskValue(r.pending) : '—'}</td>
                  <td className={retro.num}>{formatIskValue(r.net)}</td>
                </tr>
              )
            }, rows)}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <th />
              <th />
              <th className={retro.num}>{totals.jobs}</th>
              <th className={retro.num}>{formatIskValue(totals.paid)}</th>
              <th className={retro.num}>{formatIskValue(totals.rebated)}</th>
              <th className={retro.num}>{formatIskValue(totals.pending)}</th>
              <th className={retro.num}>{formatIskValue(totals.net)}</th>
            </tr>
          </tfoot>
        </table>
      ) : (
        <p>No facility tax received and no tax refunds paid in the last {days === 1 ? 'day' : `${days} days`}.</p>
      )}
    </>
  )
}
export default RebatesPage
