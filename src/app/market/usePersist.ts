'use client'

import { useEffect, useState } from 'react'

export const usePersist = <T>(
  key: string,
  initial: T,
  parse: (raw: string) => T | undefined,
): [T, (value: T) => void] => {
  const [value, setValue] = useState<T>(initial)

  useEffect(() => {
    const saved = window.localStorage.getItem(key)
    if (saved === null) return
    const parsed = parse(saved)
    if (parsed !== undefined) setValue(parsed)
  }, [key])

  const set = (next: T) => {
    setValue(next)
    window.localStorage.setItem(key, String(next))
  }

  return [value, set]
}
