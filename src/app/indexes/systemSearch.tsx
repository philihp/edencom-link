'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import { searchSystems, watchSystem } from './actions'
import styles from './indexes.module.css'

const DEBOUNCE_MS = 500

type Result = [systemID: number, name: string, security: number]

// Debounced system-name autocomplete for adding a system to the watch list.
// Mirrors the blueprint page's TypeSearch; results resolve from the locally
// generated SDE data via a server action, and picking one calls the
// watchSystem action (which revalidates the page, so the new row appears).
export const SystemSearch = () => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [adding, startAdding] = useTransition()
  const timeoutRef = useRef<number | undefined>(undefined)
  // Tracks the latest issued query so a slow response can't clobber a newer one.
  const latestRef = useRef('')

  const runSearch = (term: string) => {
    const trimmed = term.trim()
    if (trimmed === '') {
      latestRef.current = ''
      setResults([])
      setSearched(false)
      setSearching(false)
      return
    }
    latestRef.current = trimmed
    setSearching(true)
    searchSystems(trimmed).then((found) => {
      if (latestRef.current !== trimmed) return
      setResults(found)
      setSearching(false)
      setSearched(true)
    })
  }

  // Debounced autocomplete: fires on its own a short while after typing stops.
  useEffect(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current)
    if (query.trim() === '') {
      runSearch('')
      return
    }
    timeoutRef.current = window.setTimeout(() => runSearch(query), DEBOUNCE_MS)
    return () => window.clearTimeout(timeoutRef.current)
  }, [query])

  const add = (systemID: number) => {
    startAdding(async () => {
      await watchSystem(systemID)
      setResults((r) => r.filter(([id]) => id !== systemID))
    })
  }

  return (
    <div className={styles.search}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (timeoutRef.current) window.clearTimeout(timeoutRef.current)
          runSearch(query)
        }}
      >
        <input type="text" value={query} placeholder="System name…" onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" disabled={query.trim() === '' || searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      <ul className={styles.searchResults}>
        {results.map(([systemID, name, security]) => (
          <li key={systemID}>
            <button type="button" onClick={() => add(systemID)} disabled={adding}>
              + {name} <span className={styles.security}>{security.toFixed(1)}</span>
            </button>
          </li>
        ))}
      </ul>
      {searched && !searching && results.length === 0 && <p>No systems found.</p>}
    </div>
  )
}
