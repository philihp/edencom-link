'use client'

import { useEffect, useState } from 'react'

import { generateApiToken } from './actions'
import Dot from './dot'

const ApiToken = ({ initialToken }: { initialToken: string | null }) => {
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

  const url = token ? `${origin}/api/assets?token=${token}&at=${new Date().toISOString()}` : null

  return (
    <>
      <h2>API Access (Google Sheets)</h2>
      <p>
        Pull your total asset inventory into a spreadsheet with <code>=ImportJSON(url)</code>. The optional{' '}
        <code>at</code> timestamp (ISO 8601) reconstructs your inventory as it was at that moment; omit it for the
        current inventory.
      </p>
      {url && (
        <p>
          <code>=ImportJSON(&quot;{url}&quot;)</code>
        </p>
      )}
      <form>
        <button formAction={generate}>{token ? 'Regenerate API token' : 'Generate API token'}</button>
      </form>
      {token && <p>Regenerating invalidates the previous token and any sheet still using it.</p>}
      <p>{response && <Dot color={color} response={response} />}</p>
    </>
  )
}

export default ApiToken
