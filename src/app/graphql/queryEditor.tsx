'use client'

import { useState } from 'react'

import { csvRows } from '@/app/lens/flatten'
import { LENS_TEMPLATES } from '@/app/lens/templates'
import { toCsv } from '@/utils/csv'
import styles from './graphql.module.css'

// Deliberately simple in-browser editor (no GraphiQL dependency): a query
// textarea, an optional variables JSON textarea, and the raw JSON response.
// Posts same-origin, so the Supabase session cookie authenticates it.
//
// GET /api/graphql serves GraphiQL, which is where the schema-aware
// autocomplete and the docs explorer live. This page keeps the examples —
// the shared lens template list (src/app/lens/templates.ts), since a lens IS
// a stored query of this same shape — and the CSV download GraphiQL can't
// offer, via the same Lens flattening (src/app/lens/flatten.ts).

const EXAMPLES = LENS_TEMPLATES

export const QueryEditor = () => {
  const [query, setQuery] = useState(EXAMPLES[0].query)
  const [variables, setVariables] = useState('')
  const [result, setResult] = useState('')
  // The last result as CSV, or '' when the response holds no single row list
  // (several root fields at once) — which disables the download rather than
  // handing over a misleading file.
  const [csv, setCsv] = useState('')
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
      setCsv(toCsv(csvRows(json?.data)))
    } catch (e) {
      setResult(`Request failed: ${e instanceof Error ? e.message : String(e)}`)
      setCsv('')
    } finally {
      setRunning(false)
    }
  }

  // Entity edges nest one level (`character { name }`), which csvRows joins into
  // `owner.name` columns — so a query written by clicking through the docs
  // explorer downloads as a spreadsheet with no rewrite into flat scalars.
  const downloadCsv = () => {
    if (csv === '') return
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'edencom-link.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const loadExample = (label: string) => {
    const example = EXAMPLES.find((e) => e.label === label)
    if (!example) return
    setQuery(example.query)
    setVariables(example.variables ? JSON.stringify(example.variables, null, 2) : '')
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
        {result !== '' && (
          <button type="button" onClick={downloadCsv} disabled={csv === ''}>
            Download CSV
          </button>
        )}
      </div>
      {result !== '' && <pre className={styles.result}>{result}</pre>}
    </div>
  )
}
