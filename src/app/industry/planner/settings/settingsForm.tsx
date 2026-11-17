'use client'
// The planner's numbers as one form: percents and ISK per m3 in the boxes,
// fractions in the table. The form saves as a whole, and a bad field refuses
// the save with a line that names it.
import { useState, useTransition } from 'react'

import industryStyles from '../../industry.module.css'
import styles from '../planner.module.css'
import { saveSettings } from './actions'
import { HOME_MARKETS, NUMBER_FIELDS, toPercent, type PlannerSettings } from './settings'

// What each number does to the plan, under its label.
const WHY: Record<(typeof NUMBER_FIELDS)[number]['key'], string> = {
  overbuild: 'Extra components to keep, as a part of what the plan needs for its own builds.',
  minimumMargin: 'A market target counts only when the margin in that market is at or above this.',
  marketFees: 'Broker fee and sales tax together, taken from each sale.',
  sccTax: 'The SCC surcharge on every industry job, on top of the facility tax.',
  haulImport: 'ISK per packaged m³ to bring an item from Jita to the home market.',
  haulExport: 'ISK per packaged m³ to take an item from the home market to Jita.',
}

export const SettingsForm = ({ settings }: { settings: PlannerSettings }) => {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const save = (formData: FormData) =>
    startTransition(async () => {
      const result = await saveSettings(formData)
      setMessage(result.error ? { ok: false, text: result.error } : { ok: true, text: result.ok ?? 'Saved.' })
    })

  return (
    <form action={save} className={styles.settingsForm}>
      <label className={styles.settingsRow}>
        <span className={styles.settingsName}>Home market</span>
        <select name="homeMarket" defaultValue={settings.homeMarket}>
          {HOME_MARKETS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className={styles.settingsWhy}>The market the plan stocks and prices beside Jita.</span>
      </label>
      {NUMBER_FIELDS.map((f) => (
        <label key={f.key} className={styles.settingsRow}>
          <span className={styles.settingsName}>{f.label}</span>
          <span>
            <input
              name={f.key}
              type="number"
              min={f.min}
              max={f.max}
              step="any"
              required
              className={styles.quantity}
              defaultValue={f.unit === 'percent' ? toPercent(settings[f.key]) : settings[f.key]}
            />{' '}
            <span className={industryStyles.faint}>{f.unit === 'percent' ? '%' : 'ISK/m³'}</span>
          </span>
          <span className={styles.settingsWhy}>{WHY[f.key]}</span>
        </label>
      ))}
      <div className={styles.settingsActions}>
        <button type="submit" disabled={pending}>
          save settings
        </button>
        {message && (
          <span role="status" className={message.ok ? industryStyles.faint : styles.settingsError}>
            {message.text}
          </span>
        )}
      </div>
    </form>
  )
}
