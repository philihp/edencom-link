import Link from 'next/link'
import { redirect } from 'next/navigation'
import { reduce, uniq } from 'ramda'

import { createClient } from '@/utils/supabase/server'
import { formatBisk } from '../isk'
import { resolveLocations } from '../resolveLocations'
import { fetchSystemNames } from '../systemNames'
import { fetchTypeNames } from '../typeNames'
import { register, setMainCharacter } from './actions'
import MainCharacterForm from './mainCharacterForm'
import { requiredScopes } from './scopes'
import { getEnabledScopes } from './userScopes'
import styles from './character.module.css'

const CharacterPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const { data: characters, status, statusText, error } = await supabase.from('registration').select()

  const { data: wallets } = await supabase
    .from('character_wallet')
    .select('character_id, balance, recorded_at')
    .order('recorded_at', { ascending: false })

  const latestBalance = reduce(
    (acc, w) => (acc.has(w.character_id) ? acc : acc.set(w.character_id, w.balance)),
    new Map<string, string>(),
    wallets ?? []
  )

  const { data: locations } = await supabase.from('character_location').select('character_id, solar_system_id')
  const systemNames = await fetchSystemNames((locations ?? []).map((l) => Number(l.solar_system_id)))
  const locationSystem = new Map(
    (locations ?? []).map((l) => [
      l.character_id as string,
      systemNames[Number(l.solar_system_id)] ?? `System #${l.solar_system_id}`,
    ])
  )

  const { data: clones } = await supabase.from('character_clone').select('character_id, location_id, location_type')
  const { systemFor } = await resolveLocations(
    (clones ?? []).map((c) => ({ id: String(c.location_id), type: c.location_type }))
  )
  const cloneSystems = reduce(
    (acc, c) => {
      const system = systemFor({ id: String(c.location_id), type: c.location_type }) ?? `#${c.location_id}`
      const existing = acc.get(c.character_id as string) ?? []
      acc.set(c.character_id as string, uniq([...existing, system]))
      return acc
    },
    new Map<string, string[]>(),
    clones ?? []
  )

  const { data: implantRows } = await supabase.from('character_implant').select('character_id, type_ids')
  const implantTypeNames = await fetchTypeNames((implantRows ?? []).flatMap((r) => (r.type_ids ?? []).map(Number)))
  const implantsByCharacter = new Map(
    (implantRows ?? []).map((r) => [
      r.character_id as string,
      (r.type_ids ?? []).map((id: number) => implantTypeNames[id] ?? `Type #${id}`),
    ])
  )

  // If the player has turned off every optional ESI scope, characters they add
  // grant nothing beyond identification, so almost no features will work.
  const enabledScopes = await getEnabledScopes(supabase, data.user.id)
  const hasNoOptionalScopes = enabledScopes.every((scope) => requiredScopes.includes(scope))

  const mainId = characters?.find((c) => c.is_main)?.id ?? null

  return (
    <>
      <h1>Characters</h1>
      {hasNoOptionalScopes && (
        <div className={styles.warning} role="alert">
          <strong className={styles.warningTitle}>Limited access selected</strong>
          <p className={styles.warningBody}>
            You haven&apos;t enabled any ESI permissions, so characters you add will only be identified — no wallet,
            assets, industry, market, or structure data can be tracked. Choose what to share in{' '}
            <Link href="/settings/grants">settings</Link>.
          </p>
        </div>
      )}
      <MainCharacterForm mainId={mainId} hasCharacters={!!characters?.length} action={setMainCharacter}>
        <ul className={styles.grid}>
          {characters?.map((c) => (
            <li key={`character-${c.id}`} className={styles.tile}>
              {c.character_id ? (
                <img
                  className={styles.avatar}
                  src={`https://images.evetech.net/characters/${c.character_id}/portrait?size=128`}
                  alt={c.name}
                />
              ) : (
                <div className={styles.avatar} aria-hidden="true" />
              )}
              <div className={styles.body}>
                <div className={styles.name}>{c.name}</div>
                <div className={styles.meta}>
                  <span className={styles.metaLabel}>ISK:</span>
                  {latestBalance.has(c.id) ? formatBisk(latestBalance.get(c.id)!) : '—'}
                </div>
                <div className={styles.meta}>
                  <span className={styles.metaLabel}>Location:</span>
                  {locationSystem.get(c.id) ?? '—'}
                </div>
                <div className={styles.meta}>
                  <span className={styles.metaLabel}>Ship:</span>
                </div>
                {(cloneSystems.get(c.id)?.length ?? 0) > 0 && (
                  <div className={styles.metaBlock}>
                    <span className={styles.metaLabel}>Clone systems:</span>
                    <ul className={styles.bulletList}>
                      {cloneSystems.get(c.id)!.map((system) => (
                        <li key={system}>{system}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(implantsByCharacter.get(c.id)?.length ?? 0) > 0 && (
                  <div className={styles.metaBlock}>
                    <span className={styles.metaLabel}>Implants:</span>
                    <ul className={styles.bulletList}>
                      {implantsByCharacter.get(c.id)!.map((name: string, i: number) => (
                        <li key={i}>{name}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <label className={styles.meta}>
                  <input type="radio" name="main" value={c.id} defaultChecked={c.is_main} /> Main Character
                </label>
              </div>
            </li>
          ))}
        </ul>
      </MainCharacterForm>
      {error && (
        <>
          <strong>
            {status}: {statusText}
          </strong>
          <br />
          <em>
            {error.code}: {error.message}
          </em>
          <pre>{JSON.stringify(error, undefined, 2)}</pre>
        </>
      )}
      <form className={styles.actions}>
        <button formAction={register}>Add Character</button>
      </form>
    </>
  )
}
export default CharacterPage
