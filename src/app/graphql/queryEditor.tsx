'use client'

import { useState } from 'react'

import styles from './graphql.module.css'

// Deliberately simple in-browser editor (no GraphiQL dependency): a query
// textarea, an optional variables JSON textarea, and the raw JSON response.
// Posts same-origin, so the Supabase session cookie authenticates it.

const EXAMPLES: Array<{ label: string; query: string }> = [
  {
    label: 'Wallet balances',
    query: `{
  walletBalances {
    ownerName
    balance
    recordedAt
  }
}`,
  },
  {
    label: 'Stockpile by item',
    query: `query Stockpile($item: String!) {
  assets(typeName: $item) {
    totalCount
    truncated
    rows {
      typeName
      quantity
      locationName
      ownerName
    }
  }
}`,
  },
  {
    label: 'Open orders',
    query: `{
  marketOrders {
    typeName
    isBuy
    price
    volumeRemain
    locationName
    ownerName
  }
}`,
  },
  {
    label: 'Industry jobs',
    query: `{
  industryJobs {
    blueprintTypeName
    productTypeName
    activityId
    runs
    status
    endDate
    locationName
    ownerName
  }
}`,
  },
]

const EXAMPLE_VARIABLES: Record<string, string> = {
  'Stockpile by item': `{ "item": "Tritanium" }`,
}

export const QueryEditor = () => {
  const [query, setQuery] = useState(EXAMPLES[0].query)
  const [variables, setVariables] = useState('')
  const [result, setResult] = useState('')
  const [running, setRunning] = useState(false)

  const run = async () => {
    let parsedVariables: unknown
    const trimmed = variables.trim()
    if (trimmed !== '') {
      try {
        parsedVariables = JSON.parse(trimmed)
      } catch {
        setResult('Variables must be a JSON object, e.g. { "item": "Tritanium" }')
        return
      }
    }
    setRunning(true)
    try {
      const response = await fetch('/api/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: parsedVariables }),
      })
      const json = await response.json()
      setResult(JSON.stringify(json, null, 2))
    } catch (e) {
      setResult(`Request failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const loadExample = (label: string) => {
    const example = EXAMPLES.find((e) => e.label === label)
    if (!example) return
    setQuery(example.query)
    setVariables(EXAMPLE_VARIABLES[label] ?? '')
  }

  return (
    <div className={styles.editor}>
      <div className={styles.examples}>
        {EXAMPLES.map((e) => (
          <button key={e.label} type="button" onClick={() => loadExample(e.label)}>
            {e.label}
          </button>
        ))}
      </div>
      <label className={styles.field}>
        Query
        <textarea
          className={styles.query}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={14}
          spellCheck={false}
        />
      </label>
      <label className={styles.field}>
        Variables (JSON, optional)
        <textarea
          className={styles.variables}
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
          rows={3}
          spellCheck={false}
        />
      </label>
      <div>
        <button type="button" onClick={run} disabled={running || query.trim() === ''}>
          {running ? 'Running…' : 'Run query'}
        </button>
      </div>
      {result !== '' && <pre className={styles.result}>{result}</pre>}
    </div>
  )
}
