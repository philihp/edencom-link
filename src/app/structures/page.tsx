import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { character as fetchCharacter, corpStructures } from '@/esi'

import { getFreshAccessToken, type TokenRow } from './auth'

const STRUCTURES_SCOPE = 'esi-corporations.read_structures.v1'

type Structure = {
  structure_id: number
  corporation_id: number
  type_id: number
  system_id: number
  profile_id?: number
  name?: string
  state?: string
  fuel_expires?: string
  unanchors_at?: string
  reinforce_hour?: number
  services?: Array<{ name: string; state: string }>
}

type CharacterTokenRow = {
  id: string
  name: string
  character_id: number
  token: TokenRow | TokenRow[] | null
}

const StructuresPage = async () => {
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  const { data: rows } = await supabase
    .schema('hangar')
    .from('character')
    .select('id, name, character_id, token(id, character_id, access_token, refresh_token, expires_at, scope)')

  const characters = ((rows ?? []) as CharacterTokenRow[])
    .map((c) => {
      const token = Array.isArray(c.token) ? c.token[0] : c.token
      return token ? { ...c, token } : null
    })
    .filter(
      (c): c is CharacterTokenRow & { token: TokenRow } =>
        c !== null && c.token.scope.includes(STRUCTURES_SCOPE),
    )

  const seenCorps = new Set<number>()
  const errors: string[] = []
  const structures: Structure[] = []

  for (const c of characters) {
    const accessToken = await getFreshAccessToken(supabase, c.token)
    if (!accessToken) {
      errors.push(`${c.name}: could not refresh access token`)
      continue
    }

    try {
      const charInfo = await fetchCharacter(accessToken, c.character_id)
      const corpId: number = charInfo.corporation_id
      if (seenCorps.has(corpId)) continue
      seenCorps.add(corpId)

      const [firstPage, pagesHeader] = await corpStructures(accessToken, corpId, 1)
      const totalPages = Math.max(1, Number(pagesHeader) || 1)
      const corpStructs: Structure[] = [...firstPage]
      for (let page = 2; page <= totalPages; page++) {
        const [more] = await corpStructures(accessToken, corpId, page)
        corpStructs.push(...more)
      }

      structures.push(...corpStructs)
    } catch (err) {
      errors.push(`${c.name}: ${(err as Error).message}`)
    }
  }

  return (
    <>
      <h1>Structures</h1>
      {characters.length === 0 && (
        <p>
          No characters with the structures scope. Re-link a director character on the{' '}
          <a href="/character">Characters</a> page to grant access.
        </p>
      )}
      {structures.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Structure ID</th>
              <th>Type ID</th>
              <th>System ID</th>
              <th>State</th>
              <th>Fuel Expires</th>
              <th>Unanchors At</th>
              <th>Services</th>
            </tr>
          </thead>
          <tbody>
            {structures.map((s) => (
              <tr key={`structure-${s.structure_id}`}>
                <td>{s.structure_id}</td>
                <td>{s.type_id}</td>
                <td>{s.system_id}</td>
                <td>{s.state ?? '—'}</td>
                <td>{s.fuel_expires ?? '—'}</td>
                <td>{s.unanchors_at ?? '—'}</td>
                <td>{s.services?.map((svc) => svc.name).join(', ') ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        characters.length > 0 && <p>No structures visible to your characters.</p>
      )}
      {errors.length > 0 && (
        <>
          <h2>Errors</h2>
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
export default StructuresPage
