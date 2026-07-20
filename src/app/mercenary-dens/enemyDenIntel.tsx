'use client'

import { useState, useTransition } from 'react'

import { addEnemyDenIntel, deleteEnemyDenIntel } from './actions'
import { Countdown } from './countdown'
import CopyDiscordPing from './copyDiscordPing'
import { formatUtc } from './duration'
import styles from './mercenaryDens.module.css'

export type EnemyDenIntelRow = {
  id: number
  system: string
  planet: string
  owner: string | null
  reinforcementEnd: string | null
  notes: string | null
  reportedBy: string
  createdAt: string
  mine: boolean
}

// User-submitted corkboard of enemy dens seen reinforced — there's no ESI feed
// for another corp's dens, so this is manually reported. A form to post a new
// sighting, plus the shared list sorted soonest-reinforcement-first; a
// submitter can delete their own rows (server-enforced by RLS). "Reported by"
// is fixed to the caller's main character (derived server-side), and the
// reinforcement time defaults to 24h out (date only, so the reporter fills in
// just the time).
const EnemyDenIntel = ({
  rows,
  defaultReportedBy,
  defaultReinforcementEnd,
  now,
}: {
  rows: EnemyDenIntelRow[]
  defaultReportedBy: string
  defaultReinforcementEnd: string
  // Server render time — used for the reinforced/expired split and as the
  // Countdown's hydration-safe starting point (its display then ticks live).
  now: number
}) => {
  const emptyForm = { system: '', planet: '', owner: '', reinforcementEnd: defaultReinforcementEnd, notes: '' }
  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()

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
      setForm(emptyForm)
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
        No ESI feed exists for another corp&apos;s dens — report sightings here so the timers are visible to whoever you
        share your dens with, above.
      </p>

      <form className={styles.intelForm} onSubmit={onSubmit}>
        <input type="text" placeholder="System" value={form.system} onChange={set('system')} required />
        <input type="text" placeholder="Planet (e.g. III)" value={form.planet} onChange={set('planet')} required />
        <input type="text" placeholder="Owner (optional)" value={form.owner} onChange={set('owner')} />
        <input
          type="text"
          className={styles.reinforcement}
          placeholder="Reinforced at (YYYY-MM-DDTHH:MM:SS UTC)"
          value={form.reinforcementEnd}
          onChange={set('reinforcementEnd')}
          pattern="\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}"
          title="Reinforcement ends at, in EVE/UTC time — ISO 8601 with seconds, e.g. 2026-07-20T14:30:45"
        />
        <input type="text" placeholder="Notes (optional)" value={form.notes} onChange={set('notes')} />
        <span className={styles.reportingAs}>Reporting as {defaultReportedBy || '—'}</span>
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
                <td>{row.owner || dash}</td>
                <td>
                  {row.reinforcementEnd ? (
                    new Date(row.reinforcementEnd).getTime() > now ? (
                      <>
                        <span className={styles.reinforced}>
                          reinforced <Countdown end={row.reinforcementEnd} now={now} />
                        </span>
                        <span className={styles.timestamp}> {formatUtc(row.reinforcementEnd)}</span>
                        <CopyDiscordPing
                          system={row.system}
                          planet={row.planet}
                          reinforcementEnd={row.reinforcementEnd}
                          enemy
                        />
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
