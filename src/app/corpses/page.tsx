import { redirect } from 'next/navigation'

import { corpsesFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'

import { DateTime } from '../DateTime'
import styles from './corpses.module.css'

// Every player corpse in EVE is the same type — typeID 25, "Corpse". They're
// singleton items, so the extract job resolves each one's ESI asset name, which
// for a corpse reads "<pilot>'s Frozen Corpse".
const CORPSE_TYPE_ID = 25

// A corpse first seen within this window is flagged "New!".
const NEW_WINDOW_MS = 48 * 60 * 60 * 1000

// Strip the "'s Frozen Corpse" suffix ESI tacks onto a corpse's name, leaving
// just the dead pilot's name. Straight or curly apostrophe, case-insensitive.
const pilotFromName = (name: string | null): string | null => {
  const trimmed = name?.trim()
  if (!trimmed) return null
  return trimmed.replace(/['’]s\s+Frozen\s+Corpse$/i, '').trim() || trimmed
}

// Read fresh — the character_asset view moves underneath this page as new
// extracts land.
export const dynamic = 'force-dynamic'

type CorpseRow = {
  item_id: number | string
  name: string | null
  first_seen_at: string | null
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
    .select('item_id, name, first_seen_at')
    .eq('type_id', CORPSE_TYPE_ID)
    .returns<CorpseRow[]>()

  const cutoff = Date.now() - NEW_WINDOW_MS

  // The pilot name lives in the asset name; a corpse whose name hasn't been
  // resolved yet falls back to its item id so it still shows in the tally.
  const corpses = (rows ?? [])
    .map((r) => {
      const firstSeenMs = r.first_seen_at ? new Date(r.first_seen_at).getTime() : NaN
      return {
        itemId: String(r.item_id),
        pilot: pilotFromName(r.name),
        firstSeen: r.first_seen_at,
        isNew: Number.isFinite(firstSeenMs) && firstSeenMs >= cutoff,
      }
    })
    .sort((a, b) => (a.pilot ?? '').localeCompare(b.pilot ?? '', undefined, { sensitivity: 'base' }))

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>Corpses</h1>
        {corpses.length > 0 && <span className={styles.count}>{corpses.length}</span>}
      </div>

      {corpses.length > 0 ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Pilot</th>
              <th>First seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {corpses.map(({ itemId, pilot, firstSeen, isNew }) => (
              <tr key={itemId}>
                <td className={styles.pilot}>
                  {pilot ?? <span className={styles.unknown}>Unknown (#{itemId})</span>}
                </td>
                <td className={styles.seen}>
                  <DateTime value={firstSeen} />
                </td>
                <td>{isNew && <span className={styles.badge}>New!</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className={styles.empty}>No corpses in your hangars.</p>
      )}
    </>
  )
}
export default CorpsesPage
