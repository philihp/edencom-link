import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

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
      'structure_id, corporation_id, type_id, system_id, name, state, fuel_expires, unanchors_at, services, last_seen_at',
    )
    .order('corporation_id', { ascending: true })
    .order('structure_id', { ascending: true })

  const list = (structures ?? []) as Structure[]

  return (
    <>
      <h1>Structures</h1>
      {list.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Structure ID</th>
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
                <td>{s.structure_id}</td>
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
