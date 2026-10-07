'use client'

import { useEffect, useRef, useState } from 'react'

// A choice remembered in localStorage across visits: a page's time window, an
// owner filter, a threshold. The first render takes `initial` on both sides of
// hydration — the server has no storage and the client must agree with it —
// and the saved value is applied in an effect after mount. Reading storage in
// the state initialiser instead (what this did until 2026-10) rendered a
// different first frame on the client than the server had sent, which is a
// hydration mismatch React patches up with a warning and a re-render.
//
// `parse` turns the stored string back into a value, or undefined to reject
// it (a stale id, an option that no longer exists); `set` stores via
// String(), so an array stores comma-joined. Storage can be absent or throw
// (private windows, blocked site data): every access is guarded, and the
// choice still applies for the visit.
export const usePersist = <T>(
  key: string,
  initial: T,
  parse: (raw: string) => T | undefined
): [T, (value: T) => void] => {
  const [value, setValue] = useState<T>(initial)
  const parseRef = useRef(parse)
  parseRef.current = parse

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key)
      if (saved === null) return
      const parsed = parseRef.current(saved)
      if (parsed !== undefined) setValue(parsed)
    } catch {
      // No storage, no saved choice.
    }
  }, [key])

  const set = (next: T) => {
    setValue(next)
    try {
      window.localStorage.setItem(key, String(next))
    } catch {
      // Storage refused; the choice still applies this visit.
    }
  }

  return [value, set]
}
