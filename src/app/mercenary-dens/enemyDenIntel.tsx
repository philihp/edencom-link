'use client'

import { useState, useTransition } from 'react'

import { addEnemyDenIntel, deleteEnemyDenIntel } from './actions'
import { formatDuration, formatUtc } from './duration'
import styles from './mercenaryDens.module.css'

export type EnemyDenIntelRow = {
  id: number
  system: string
  planet: string
  owner: string
  alliance: string | null
  reinforcementEnd: string | null
  notes: string | null
  reportedBy: string
  createdAt: string
  mine: boolean
}

const EMPTY_FORM = { system: '', planet: '', owner: '', alliance: '', reinforcementEnd: '', notes: '', reportedBy: '' }

// User-submitted corkboard of enemy dens seen reinforced — there's no ESI feed
// for another corp's dens, so this is manually reported. A form to post a new
// sighting, plus the shared list sorted soonest-reinforcement-first; a
// submitter can delete their own rows (server-enforced by RLS).
const EnemyDenIntel = ({ rows, defaultReportedBy }: { rows: EnemyDenIntelRow[]; defaultReportedBy: string }) => {
  const [form, setForm] = useState({ ...EMPTY_FORM, reportedBy: defaultReportedBy })
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()
  const now = Date.now()

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }))

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    startTransition(async () => {
      const result = await addEnemyDenIntel(form)
      if (result.error) {
        setError(result.error)
        return
      }
      setForm({ ...EMPTY_FORM, reportedBy: form.reportedBy })
    })
  }

  const onDelete = (id: number) => {
    startTransition(async () => {
      await deleteEnemyDenIntel(id)
    })
  }

  const dash = <span className={styles.empty}>—</span>

  return (
    <>
      <h2>Enemy den intel</h2>
      <p className={styles.subtitle}>
        No ESI feed exists for another corp&apos;s dens — report sightings here so the timers are visible to everyone.
      </p>

      <form className={styles.intelForm} onSubmit={onSubmit}>
        <input type="text" placeholder="System" value={form.system} onChange={set('system')} required />
        <input type="text" placeholder="Planet (e.g. III)" value={form.planet} onChange={set('planet')} required />
        <input type="text" placeholder="Owner" value={form.owner} onChange={set('owner')} required />
        <input type="text" placeholder="Alliance (optional)" value={form.alliance} onChange={set('alliance')} />
        <input
          type="datetime-local"
          value={form.reinforcementEnd}
          onChange={set('reinforcementEnd')}
          title="Reinforcement ends at (enter in EVE/UTC time)"
        />
        <input type="text" placeholder="Notes (optional)" value={form.notes} onChange={set('notes')} />
        <input type="text" placeholder="Reported by" value={form.reportedBy} onChange={set('reportedBy')} required />
        <button type="submit" disabled={pending}>
          Report sighting
        </button>
      </form>
      {error && <span className={styles.shareError}>{error}</span>}

      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>System</th>
              <th>Planet</th>
              <th>Owner</th>
              <th>Reinforced</th>
              <th>Notes</th>
              <th>Reported by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={styles.system}>{row.system}</td>
                <td className={styles.planet}>{row.planet}</td>
                <td>
                  {row.owner}
                  {row.alliance ? <span className={styles.alliance}> [{row.alliance}]</span> : null}
                </td>
                <td>
                  {row.reinforcementEnd ? (
                    new Date(row.reinforcementEnd).getTime() > now ? (
                      <>
                        <span className={styles.reinforced}>
                          reinforced {formatDuration(new Date(row.reinforcementEnd).getTime() - now)}
                        </span>
                        <span className={styles.timestamp}> {formatUtc(row.reinforcementEnd)}</span>
                      </>
                    ) : (
                      <span className={styles.stable}>timer expired {formatUtc(row.reinforcementEnd)}</span>
                    )
                  ) : (
                    dash
                  )}
                </td>
                <td>{row.notes ?? dash}</td>
                <td>{row.reportedBy}</td>
                <td>
                  {row.mine ? (
                    <button
                      type="button"
                      className={styles.copyButton}
                      onClick={() => onDelete(row.id)}
                      disabled={pending}
                      title="Remove this sighting"
                      aria-label="Remove this sighting"
                    >
                      ✕
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.empty}>
                  No enemy den sightings reported yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

export default EnemyDenIntel
