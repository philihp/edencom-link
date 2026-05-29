import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { DateTime } from '../DateTime'
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

type Transaction = {
  location_id: number | string
  unit_price: number | string
  quantity: number | string
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

  // Total up every transaction's amount (unit price × quantity) per structure it happened at.
  // structure_id / location_id are bigints, which PostgREST may return as strings; key the map by
  // string on both sides so the lookup doesn't silently miss (and totals don't all read as zero).
  const structureIds = list.map((s) => Number(s.structure_id))
  const { data: transactions } = structureIds.length
    ? await supabase
        .schema('hangar')
        .from('market_transaction')
        .select('location_id, unit_price, quantity')
        .in('location_id', structureIds)
    : { data: [] }

  const totalByStructure = new Map<string, number>()
  for (const t of (transactions ?? []) as Transaction[]) {
    const id = String(t.location_id)
    totalByStructure.set(id, (totalByStructure.get(id) ?? 0) + Number(t.unit_price) * Number(t.quantity))
  }

  return (
    <>
      <h1>Structures</h1>
      {list.length > 0 ? (
        <>
          <table className={retro.retro} border={3} cellPadding={2} cellSpacing={0}>
            <thead>
              <tr>
                <th>Structure ID</th>
                <th>Station ID</th>
                <th>Name</th>
                <th>Transactions Total</th>
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
                  <td>
                    <a href={`/structures/${s.structure_id}`}>{s.structure_id}</a>
                  </td>
                  {/* Upwell structures share their structure_id with the station/facility id industry jobs run at. */}
                  <td>{s.structure_id}</td>
                  <td>{s.name ?? '—'}</td>
                  <td>{formatIsk(totalByStructure.get(String(s.structure_id)) ?? 0)}</td>
                  <td>{s.corporation_id}</td>
                  <td>{s.type_id}</td>
                  <td>{s.system_id}</td>
                  <td>{s.state ?? '—'}</td>
                  <td>
                    <DateTime value={s.fuel_expires} />
                  </td>
                  <td>
                    <DateTime value={s.unanchors_at} />
                  </td>
                  <td>{s.services?.map((svc) => svc.name).join(', ') ?? '—'}</td>
                  <td>
                    <DateTime value={s.last_seen_at} />
                  </td>
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
    </>
  )
}
export default StructuresPage
