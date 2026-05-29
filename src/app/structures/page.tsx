import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import retro from '../retro.module.css'

type Structure = {
  structure_id: number
  corporation_id: number
  type_id: number
  system_id: number
  name: string | null
  state: string | null
  fuel_expires: string | null
  unanchors_at: string | null
  services: Array<{ name: string; state: string }> | null
  last_seen_at: string
}

type JournalEntry = {
  corporation_id: number
  division: number
  entry_id: string | number
  date: string
  ref_type: string
  amount: string | number | null
  balance: string | number | null
  description: string | null
  reason: string | null
}

const formatIsk = (raw: string | number | null) => {
  if (raw === null) return '—'
  const n = Number(raw)
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const StructuresPage = async () => {
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  const { data: structures } = await supabase
    .schema('hangar')
    .from('corp_structure')
    .select(
      'structure_id, corporation_id, type_id, system_id, name, state, fuel_expires, unanchors_at, services, last_seen_at'
    )
    .order('corporation_id', { ascending: true })
    .order('structure_id', { ascending: true })

  const list = (structures ?? []) as Structure[]

  // eslint-disable-next-line react-hooks/purity
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: journal } = await supabase
    .schema('hangar')
    .from('corp_wallet_journal')
    .select('corporation_id, division, entry_id, date, ref_type, amount, balance, description, reason')
    .gte('date', thirtyDaysAgo)
    .order('date', { ascending: false })

  const journalEntries = (journal ?? []) as JournalEntry[]

  return (
    <>
      <h1>Structures</h1>
      {list.length > 0 ? (
        <>
          <table className={retro.retro} border={3} cellPadding={4} cellSpacing={2}>
            <caption>~*~ Corporation Structures ~*~</caption>
            <thead>
              <tr>
                <th>Structure ID</th>
                <th>Station ID</th>
                <th>Name</th>
                <th>Corp ID</th>
                <th>Type ID</th>
                <th>System ID</th>
                <th>State</th>
                <th>Fuel Expires</th>
                <th>Unanchors At</th>
                <th>Services</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={`structure-${s.structure_id}`}>
                  <td className={retro.id}>{s.structure_id}</td>
                  {/* Upwell structures share their structure_id with the station/facility id industry jobs run at. */}
                  <td className={retro.id}>{s.structure_id}</td>
                  <td>{s.name ?? '—'}</td>
                  <td>{s.corporation_id}</td>
                  <td>{s.type_id}</td>
                  <td>{s.system_id}</td>
                  <td>{s.state ?? '—'}</td>
                  <td>{s.fuel_expires ?? '—'}</td>
                  <td>{s.unanchors_at ?? '—'}</td>
                  <td>{s.services?.map((svc) => svc.name).join(', ') ?? '—'}</td>
                  <td>{s.last_seen_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={retro.bestViewedIn}>Best viewed in Netscape Navigator 3.0 at 800&times;600</p>
        </>
      ) : (
        <p>
          No structures visible. Re-link a director character on the <a href="/character">Characters</a> page so the
          hourly job can fetch them.
        </p>
      )}

      <h2>Corp Wallet (last 30 days)</h2>
      {journalEntries.length > 0 ? (
        <table className={retro.retro} border={3} cellPadding={4} cellSpacing={2}>
          <caption>~*~ Corp Wallet ~*~</caption>
          <thead>
            <tr>
              <th>Date</th>
              <th>Corp ID</th>
              <th>Div</th>
              <th>Ref Type</th>
              <th>Amount</th>
              <th>Balance</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {journalEntries.map((e) => (
              <tr key={`journal-${e.corporation_id}-${e.division}-${e.entry_id}`}>
                <td>{e.date}</td>
                <td>{e.corporation_id}</td>
                <td>{e.division}</td>
                <td>{e.ref_type}</td>
                <td>{formatIsk(e.amount)}</td>
                <td>{formatIsk(e.balance)}</td>
                <td>{e.description ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No corp wallet activity in the last 30 days.</p>
      )}
    </>
  )
}
export default StructuresPage
