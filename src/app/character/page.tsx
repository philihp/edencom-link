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

  return (
    <>
      <h1>Characters</h1>
      <ul className={styles.grid}>
        {characters?.map((c) => (
          <li key={`character-${c.id}`} className={styles.tile}>
            <div className={styles.avatar} aria-hidden="true" />
            <div className={styles.body}>
              <div className={styles.name}>{c.name}</div>
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
