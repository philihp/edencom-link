'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { searchType } from './actions'

const DEBOUNCE_MS = 500
const MAX_RESULTS = 8

export const TypeSearch = () => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<[typeID: string, name: string][]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
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
    searchType(trimmed).then((found) => {
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

  // Manual trigger (button / Enter) for when the autocomplete didn't fire or came back empty.
  const onManualSearch = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current)
    runSearch(query)
  }

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onManualSearch()
        }}
      >
        <input
          type="text"
          value={query}
          placeholder="Blueprint name…"
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button type="submit" disabled={query.trim() === '' || searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      <ul>
        {results.slice(0, MAX_RESULTS).map(([typeID, name]) => (
          <li key={typeID}>
            <Link href={`/blueprint/${typeID}`}>{name}</Link>
          </li>
        ))}
        {results.length > MAX_RESULTS && <li>…</li>}
      </ul>
      {searched && !searching && results.length === 0 && <p>No blueprints found.</p>}
    </>
  )
}
