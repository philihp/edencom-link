import Link from 'next/link'
import { redirect } from 'next/navigation'
import { reduce } from 'ramda'

import { createClient } from '@/utils/supabase/server'
import { register, refreshEsi, setMainCharacter } from './actions'
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
  const formatIsk = (raw: string | number) =>
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(raw))

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
                  {latestBalance.has(c.id) ? `${formatIsk(latestBalance.get(c.id)!)} ISK` : '—'}
                </div>
                <div className={styles.meta}>
                  <span className={styles.metaLabel}>Location:</span>
                </div>
                <div className={styles.meta}>
                  <span className={styles.metaLabel}>Ship:</span>
                </div>
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
        <button formAction={refreshEsi} disabled={!characters?.length}>
          Refresh ESI
        </button>
      </form>
    </>
  )
}
export default CharacterPage
