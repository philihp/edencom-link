'use client'
// The "add a type" box the planner's lists share: a search over the SDE
// mirror, a short list of matches, and a click (or Enter) that hands the
// chosen type id to the list's own server action. A type already in the list
// shows as listed and cannot be added twice.
import { useEffect, useRef, useState, useTransition } from 'react'

import { TypeIcon } from '../../typeIcon'
import industryStyles from '../industry.module.css'
import styles from './planner.module.css'
import { searchTypes } from './stock-types/actions'

const DEBOUNCE_MS = 300

export const AddType = ({
  listed,
  onAdd,
  placeholder = 'add an item type…',
}: {
  listed: ReadonlySet<number>
  onAdd: (typeId: number) => Promise<void>
  placeholder?: string
}) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<[number, string][]>([])
  const [, startTransition] = useTransition()
  const latest = useRef('')

  useEffect(() => {
    const term = query.trim()
    latest.current = term
    if (term === '') {
      setResults([])
      return
    }
    const handle = window.setTimeout(() => {
      searchTypes(term).then((found) => {
        if (latest.current === term) setResults(found)
      })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [query])

  const add = (typeId: number) => {
    setQuery('')
    setResults([])
    startTransition(() => onAdd(typeId))
  }

  return (
    <div className={styles.addBox}>
      <input
        type="search"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results.length > 0) {
            e.preventDefault()
            add(results[0][0])
          }
        }}
      />
      {results.length > 0 && (
        <ul className={styles.suggestions} role="listbox">
          {results.map(([typeId, name]) => (
            <li key={typeId}>
              <button type="button" className="quiet" disabled={listed.has(typeId)} onClick={() => add(typeId)}>
                <TypeIcon id={typeId} size={16} />
                {name}
                {listed.has(typeId) && <span className={industryStyles.faint}> · listed</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
