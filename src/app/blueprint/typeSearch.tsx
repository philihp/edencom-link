'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { searchType } from './actions'

const DEBOUNCE_MS = 500
const MAX_RESULTS = 8

export const TypeSearch = () => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<[typeID: string, name: string][]>([])
  const timeoutRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current)
    if (query.trim() === '') {
      setResults([])
      return
    }
    // Snapshot the in-flight query so a slow response can't clobber a newer one.
    const current = query
    timeoutRef.current = window.setTimeout(() => {
      searchType(current).then((found) => {
        setQuery((latest) => {
          if (latest === current) setResults(found)
          return latest
        })
      })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timeoutRef.current)
  }, [query])

  return (
    <>
      <input
        type="text"
        value={query}
        placeholder="Blueprint name…"
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <ul>
        {results.slice(0, MAX_RESULTS).map(([typeID, name]) => (
          <li key={typeID}>
            <Link href={`/blueprint/${typeID}`}>{name}</Link>
          </li>
        ))}
        {results.length > MAX_RESULTS && <li>…</li>}
      </ul>
    </>
  )
}
