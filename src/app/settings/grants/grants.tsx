'use client'

import { useState } from 'react'

import type { EsiScope } from '@/app/character/scopes'
import Dot from '@/app/account/settings/dot'

import { saveGrants } from './actions'
import styles from './grants.module.css'

type GrantsProps = {
  scopes: EsiScope[]
  enabled: string[]
  from: string
}

const Grants = ({ scopes, enabled, from }: GrantsProps) => {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(scopes.map((s) => [s.scope, Boolean(s.required) || enabled.includes(s.scope)]))
  )
  const [response, setResponse] = useState('')

  const toggle = (scope: string) => setChecked((prev) => ({ ...prev, [scope]: !prev[scope] }))

  const selectAll = () => setChecked(Object.fromEntries(scopes.map((s) => [s.scope, true])))

  // Required scopes stay checked since they are always granted.
  const unselectAll = () => setChecked(Object.fromEntries(scopes.map((s) => [s.scope, Boolean(s.required)])))

  // A successful save redirects (back to settings, or on to EVE SSO), so we only
  // surface a message when saving fails.
  const save = async (formData: FormData) => {
    const error = await saveGrants(formData)
    if (error) {
      setResponse(error)
    }
  }

  return (
    <>
      <p className={styles.intro}>
        When you add a character we ask EVE Online for permission to read the data below. Check anything you would like
        to share &mdash; we can only provide the related features for the data you grant. Changes apply to characters you
        add from now on.
      </p>
      <form>
        <input type="hidden" name="from" value={from} />
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
        <button formAction={save}>{from === 'characters' ? 'Save and add character' : 'Save ESI Access'}</button>
      </form>
      <p>{response && <Dot color="#FF0000" response={response} />}</p>
    </>
  )
}

export default Grants
