'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { searchShared } from './actions'
import { MIN_QUERY_LENGTH, type SharedSearchResult } from './searchHits'

const DEBOUNCE_MS = 500

// "Has anyone shared one of these with me?" — a substring typed here is matched
// case-insensitively against every blueprint in the libraries listed below, and
// each answer names who to ask for it.
export const SharedSearchBox = () => {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SharedSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const timeoutRef = useRef<number | undefined>(undefined)
  // Tracks the latest issued query so a slow response can't clobber a newer one.
  const latestRef = useRef('')

  const runSearch = (term: string) => {
    const trimmed = term.trim()
    latestRef.current = trimmed
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResult(null)
      setSearching(false)
      return
    }
    setSearching(true)
    searchShared(trimmed).then((found) => {
      if (latestRef.current !== trimmed) return
      setResult(found)
      setSearching(false)
    })
  }

  // Debounced: fires on its own a short while after typing stops.
  useEffect(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current)
    if (query.trim().length < MIN_QUERY_LENGTH) {
      runSearch('')
      return
    }
    timeoutRef.current = window.setTimeout(() => runSearch(query), DEBOUNCE_MS)
    return () => window.clearTimeout(timeoutRef.current)
  }, [query])

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
          placeholder="Search shared libraries…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={query.trim().length < MIN_QUERY_LENGTH || searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {result != null && !searching && result.results.length === 0 && (
        <p>No shared library holds a blueprint matching “{result.query}”.</p>
      )}
      {result != null &&
        result.results.map((library) => (
          <div key={library.key}>
            <p>
              <Link href={library.href}>{library.label}</Link>
              {library.kind === 'corporation'
                ? library.sharedBy
                  ? ` — shared by ${library.sharedBy}`
                  : ' — a corporation library'
                : ''}
            </p>
            <ul>
              {library.hits.map((hit) => (
                <li key={hit.typeId}>
                  <Link href={`/blueprint/${hit.typeId}`}>{hit.name}</Link>
                  {hit.quantity > 1 ? ` ×${hit.quantity}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </>
  )
}
