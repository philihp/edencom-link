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
  const formatIsk = (raw: string | number) =>
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(raw))

  // eslint-disable-next-line react-hooks/purity
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: sales } = await supabase
    .schema('hangar')
    .from('market_transaction')
    .select('transaction_id, character_id, date, type_id, quantity, unit_price, seen_at')
    .eq('is_buy', false)
    .gte('date', sevenDaysAgo)
    .order('date', { ascending: false })

  const characterName = new Map<string, string>(characters?.map((c) => [c.id, c.name]) ?? [])
  const formatDate = (iso: string) => new Date(iso).toLocaleString()

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
      <h2>Recent Sales (last 7 days)</h2>
      {sales && sales.length > 0 ? (
        <table className={styles.sales}>
          <thead>
            <tr>
              <th>Character</th>
              <th>Type ID</th>
              <th>Qty</th>
              <th>Unit Price</th>
              <th>Total</th>
              <th>Sold</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={`sale-${s.transaction_id}`}>
                <td>{characterName.get(s.character_id) ?? '—'}</td>
                <td>{s.type_id}</td>
                <td>{s.quantity}</td>
                <td>{formatIsk(s.unit_price)}</td>
                <td>{formatIsk(Number(s.unit_price) * Number(s.quantity))}</td>
                <td>{formatDate(s.date)}</td>
                <td>{formatDate(s.seen_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No sales in the last 7 days.</p>
      )}
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
