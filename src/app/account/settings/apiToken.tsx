'use client'

import { useEffect, useState } from 'react'

import { generateApiToken } from './actions'
import Dot from './dot'
import styles from './settings.module.css'

// Every feed the token unlocks; the panel lists them as pills and folds the
// full =IMPORTDATA formulas behind a disclosure so the token row stays a
// readout.
const FEEDS = [
  { path: 'character/assets', label: 'Assets (one row per item stack)' },
  { path: 'character/blueprints', label: 'Blueprints (one row per blueprint stack)' },
  { path: 'character/jobs', label: 'Industry jobs' },
  { path: 'character/orders', label: 'Market orders (open)' },
  { path: 'corp/assets', label: 'Corp assets (one row per item stack)' },
  { path: 'corp/blueprints', label: 'Corp blueprints (one row per blueprint stack)' },
  { path: 'corp/jobs', label: 'Corp industry jobs' },
]

// Links are the primary Sheets integration and the token URLs are marked
// deprecated (docs/sharing-layer/09-sheets-parity.md). Unconditional now that
// every account has a link to be pointed at; while Links were dark-launched
// this depended on the flag, since deprecating a thing someone has no
// replacement for would have been rude.
const ApiToken = ({ initialToken }: { initialToken: string | null }) => {
  const [token, setToken] = useState(initialToken)
  const [origin, setOrigin] = useState('')
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('var(--ink)')

  // The example URL needs the deployment's own host, only known in the browser.
  useEffect(() => setOrigin(window.location.origin), [])

  const generate = async () => {
    const result = await generateApiToken()
    if (result.error) {
      setColor('var(--danger)')
      setResponse(result.error)
      return
    }
    setToken(result.token ?? null)
    setColor('var(--ok)')
    setResponse(initialToken ? 'Token regenerated — update your sheet' : 'Token generated')
  }

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>token</span>
        <span className={`${styles.value} ${styles.mono}`} style={{ fontSize: '11px' }}>
          {token ?? <span className={styles.valueQuiet}>none yet</span>}
        </span>
        <form className={styles.actForm}>
          <button formAction={generate}>{token ? 'regenerate' : 'generate token'}</button>
        </form>
      </div>
      <div className={styles.row} style={{ gridTemplateColumns: '110px 1fr' }}>
        <span className={styles.label}>feeds</span>
        <span className={styles.pills}>
          {FEEDS.map((feed) => (
            <span key={feed.path} className={styles.pill}>
              {feed.path}
            </span>
          ))}
        </span>
      </div>
      {token && origin && (
        <div className={`${styles.row} ${styles.rowWide}`}>
          <details className={styles.disclosure}>
            <summary>=IMPORTDATA formulas</summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
              {FEEDS.map((feed) => (
                <li key={feed.path} style={{ fontSize: '11px' }}>
                  {feed.label}:{' '}
                  <code>
                    =IMPORTDATA(&quot;{origin}/api/{feed.path}?token={token}&quot;)
                  </code>
                </li>
              ))}
            </ul>
            <p className={styles.valueQuiet} style={{ fontSize: '10.5px' }}>
              The assets URL accepts an optional <code>at</code> timestamp (e.g. <code>&amp;at=2026-05-30</code>) to
              reconstruct your inventory as it was at that moment; the first row is the column headers.
            </p>
          </details>
        </div>
      )}
      <div className={styles.note}>
        <span className={`${styles.tag} ${styles.tagDeprecated}`}>[ deprecated ]</span> new sheets should use a{' '}
        <a href="/link">link</a> — one query per signed URL instead of one token that unlocks everything. Token URLs
        stay for <code>at=</code> history. Regenerating invalidates any sheet still on the old token.
      </div>
      {response && (
        <div className={styles.feedback}>
          <Dot color={color} response={response} />
        </div>
      )}
    </>
  )
}

export default ApiToken
