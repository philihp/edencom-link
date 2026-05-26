'use client'

import { useState } from 'react'

export const usePersist = <T>(
  key: string,
  initial: T,
  parse: (raw: string) => T | undefined,
): [T, (value: T) => void] => {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    const saved = window.localStorage.getItem(key)
    if (saved === null) return initial
    const parsed = parse(saved)
    return parsed !== undefined ? parsed : initial
  })

  const set = (next: T) => {
    setValue(next)
    window.localStorage.setItem(key, String(next))
  }

  return [value, set]
}
