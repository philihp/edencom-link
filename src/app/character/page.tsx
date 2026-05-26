import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { register } from './actions'
import styles from './character.module.css'

const CharacterPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  const { data: characters, status, statusText, error } = await supabase.schema('hangar').from('character').select()

  const { data: wallets } = await supabase
    .schema('hangar')
    .from('wallet')
    .select('character_id, balance, recorded_at')
    .order('recorded_at', { ascending: false })

  const latestBalance = new Map<string, string>()
  for (const w of wallets ?? []) {
    if (!latestBalance.has(w.character_id)) latestBalance.set(w.character_id, w.balance)
  }
  const formatIsk = (raw: string) =>
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(raw))

  return (
    <>
      <h1>Characters</h1>
      <ul className={styles.grid}>
        {characters?.map((c) => (
          <li key={`character-${c.id}`} className={styles.tile}>
            {c.character_id ? (
              // eslint-disable-next-line @next/next/no-img-element
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
            </div>
          </li>
        ))}
      </ul>
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
      <form>
        <button formAction={register}>Add Character</button>
      </form>
    </>
  )
}
export default CharacterPage
