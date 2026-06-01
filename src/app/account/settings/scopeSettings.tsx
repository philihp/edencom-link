'use client'

import { useState } from 'react'

import type { EsiScope } from '@/app/character/scopes'

import Dot from './dot'
import { saveScopePreferences } from './scopeActions'
import styles from './scopeSettings.module.css'

type ScopeSettingsProps = {
  scopes: EsiScope[]
  enabled: string[]
}

const ScopeSettings = ({ scopes, enabled }: ScopeSettingsProps) => {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(scopes.map((s) => [s.scope, Boolean(s.required) || enabled.includes(s.scope)]))
  )
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')

  const toggle = (scope: string) => setChecked((prev) => ({ ...prev, [scope]: !prev[scope] }))

  const selectAll = () => setChecked(Object.fromEntries(scopes.map((s) => [s.scope, true])))

  // Required scopes stay checked since they are always granted.
  const unselectAll = () => setChecked(Object.fromEntries(scopes.map((s) => [s.scope, Boolean(s.required)])))

  const save = async (formData: FormData) => {
    const error = await saveScopePreferences(formData)
    if (error) {
      setColor('#FF0000')
      setResponse(error)
      return
    }
    setColor('#00AF00')
    setResponse('Preferences saved')
  }

  return (
    <>
      <h2>ESI Access</h2>
      <p className={styles.intro}>
        When you add a character we ask EVE Online for permission to read the data below. Uncheck anything you would
        rather not share &mdash; we just won&apos;t be able to provide the related features for that character. Changes
        apply to characters you add from now on.
      </p>
      <form>
        <div className={styles.bulkActions}>
          <button type="button" onClick={selectAll}>
            Select all
          </button>
          <button type="button" onClick={unselectAll}>
            Unselect all
          </button>
        </div>
        <ul className={styles.list}>
          {scopes.map((s) => (
            <li key={s.scope} className={styles.item}>
              <label className={styles.row}>
                <input
                  type="checkbox"
                  name={s.scope}
                  checked={checked[s.scope] ?? false}
                  disabled={s.required}
                  onChange={() => toggle(s.scope)}
                />
                <span className={styles.name}>{s.name}</span>
                {s.required && <span className={styles.badge}>required</span>}
              </label>
              <p className={styles.why}>{s.why}</p>
              {!checked[s.scope] && <p className={styles.without}>Without this, {s.without}</p>}
            </li>
          ))}
        </ul>
        <button formAction={save}>Save ESI Access</button>
      </form>
      <p>{response && <Dot color={color} response={response} />}</p>
    </>
  )
}

export default ScopeSettings
