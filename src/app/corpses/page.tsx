import { redirect } from 'next/navigation'

import { corpsesFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'

import styles from './corpses.module.css'

// Every player corpse in EVE is the same type — typeID 25, "Corpse". They're
// singleton items, so the extract job resolves each one's ESI asset name, which
// for a corpse is the name of the pilot it belongs to.
const CORPSE_TYPE_ID = 25

// Read fresh — the character_asset view moves underneath this page as new
// extracts land.
export const dynamic = 'force-dynamic'

type CorpseRow = {
  item_id: number | string
  name: string | null
}

const CorpsesPage = async () => {
  const supabase = await createClient()

  const { data, error: authError } = await supabase.auth.getUser()
  if (authError || !data?.user) {
    redirect('/')
  }

  if (!(await corpsesFlag())) {
    redirect('/')
  }

  // Every current corpse across the caller's characters (RLS scopes the read).
  const { data: rows } = await supabase
    .from('character_asset')
    .select('item_id, name')
    .eq('type_id', CORPSE_TYPE_ID)
    .returns<CorpseRow[]>()

  // The pilot name lives in the asset name; a corpse whose name hasn't been
  // resolved yet falls back to its item id so it still shows in the tally.
  const corpses = (rows ?? [])
    .map((r) => ({ itemId: String(r.item_id), pilot: r.name?.trim() || null }))
    .sort((a, b) => (a.pilot ?? '').localeCompare(b.pilot ?? '', undefined, { sensitivity: 'base' }))

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Corpses</h1>
        {corpses.length > 0 && <span className={styles.count}>{corpses.length}</span>}
      </div>

      {corpses.length > 0 ? (
        <ol className={styles.list}>
          {corpses.map(({ itemId, pilot }) => (
            <li key={itemId} className={styles.row}>
              {pilot ?? <span className={styles.unknown}>Unknown (#{itemId})</span>}
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.empty}>No corpses in your hangars.</p>
      )}
    </>
  )
}
export default CorpsesPage
