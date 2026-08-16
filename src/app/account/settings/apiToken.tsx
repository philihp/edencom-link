'use client'

import { useEffect, useState } from 'react'

import { generateApiToken } from './actions'
import Dot from './dot'

// `lensEnabled`: the account carries the `lens` dark-launch flag, so lenses
// are presented as the primary Sheets integration and the token URLs move
// under a Deprecated heading (docs/sharing-layer/09-sheets-parity.md). For
// unflagged accounts the token URLs stay the only offer — deprecating a thing
// someone has no replacement for would just be rude.
const ApiToken = ({ initialToken, lensEnabled }: { initialToken: string | null; lensEnabled: boolean }) => {
  const [token, setToken] = useState(initialToken)
  const [origin, setOrigin] = useState('')
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')

  // The example URL needs the deployment's own host, only known in the browser.
  useEffect(() => setOrigin(window.location.origin), [])

  const generate = async () => {
    const result = await generateApiToken()
    if (result.error) {
      setColor('#FF0000')
      setResponse(result.error)
      return
    }
    setToken(result.token ?? null)
    setColor('#00AF00')
    setResponse(initialToken ? 'Token regenerated — update your sheet' : 'Token generated')
  }

  const assetsUrl = token ? `${origin}/api/character/assets?token=${token}` : null
  const blueprintsUrl = token ? `${origin}/api/character/blueprints?token=${token}` : null
  const industryUrl = token ? `${origin}/api/character/jobs?token=${token}` : null
  const ordersUrl = token ? `${origin}/api/character/orders?token=${token}` : null
  const corpAssetsUrl = token ? `${origin}/api/corp/assets?token=${token}` : null
  const corpBlueprintsUrl = token ? `${origin}/api/corp/blueprints?token=${token}` : null
  const corpJobsUrl = token ? `${origin}/api/corp/jobs?token=${token}` : null

  return (
    <>
      <h2>API Access (Google Sheets)</h2>
      {lensEnabled && (
        <p>
          The current way to feed a spreadsheet is a <a href="/lens">lens</a>: pick a &quot;Sheets drop-in&quot;
          template (same columns as the URLs below), share it as a link, and paste the <code>=IMPORTDATA(…)</code>{' '}
          formula it shows you. A lens link exposes only that one query — unlike the API token below, which unlocks
          everything at once.
        </p>
      )}
      {lensEnabled ? (
        <h3>Deprecated: token URLs</h3>
      ) : (
        <p>
          Pull your data into a spreadsheet with <code>=IMPORTDATA(url)</code> (the first row is the column headers):
        </p>
      )}
      {lensEnabled && (
        <p>
          These keep working, but new sheets should use lenses. The one thing staying here for now is <code>at=</code>{' '}
          history — lenses read current data only.
        </p>
      )}
      {assetsUrl && blueprintsUrl && industryUrl && ordersUrl && corpAssetsUrl && corpBlueprintsUrl && corpJobsUrl && (
        <ul>
          <li>
            Assets (one row per item stack): <code>=IMPORTDATA(&quot;{assetsUrl}&quot;)</code>
          </li>
          <li>
            Blueprints (one row per blueprint stack): <code>=IMPORTDATA(&quot;{blueprintsUrl}&quot;)</code>
          </li>
          <li>
            Industry jobs: <code>=IMPORTDATA(&quot;{industryUrl}&quot;)</code>
          </li>
          <li>
            Market orders (open): <code>=IMPORTDATA(&quot;{ordersUrl}&quot;)</code>
          </li>
          <li>
            Corp assets (one row per item stack): <code>=IMPORTDATA(&quot;{corpAssetsUrl}&quot;)</code>
          </li>
          <li>
            Corp blueprints (one row per blueprint stack): <code>=IMPORTDATA(&quot;{corpBlueprintsUrl}&quot;)</code>
          </li>
          <li>
            Corp industry jobs: <code>=IMPORTDATA(&quot;{corpJobsUrl}&quot;)</code>
          </li>
        </ul>
      )}
      <p>
        The assets URL accepts an optional <code>at</code> timestamp (e.g. <code>&amp;at=2026-05-30</code>) to
        reconstruct your inventory as it was at that moment; omit it for the current inventory.
      </p>
      <form>
        <button formAction={generate}>{token ? 'Regenerate API token' : 'Generate API token'}</button>
      </form>
      {token && <p>Regenerating invalidates the previous token and any sheet still using it.</p>}
      <p>{response && <Dot color={color} response={response} />}</p>
    </>
  )
}

export default ApiToken
