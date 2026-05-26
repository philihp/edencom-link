'use client'

import { useEffect, useState } from 'react'

const cache = new Map<number, Promise<string | null>>()

const lookupName = (typeID: number): Promise<string | null> => {
  const cached = cache.get(typeID)
  if (cached) return cached
  const promise = fetch(`https://eve-build-calculator.philihp.com/api/type/${typeID}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((type: { name?: { en?: string } | string } | null) => {
      if (!type) return null
      return typeof type.name === 'string' ? type.name : (type.name?.en ?? null)
    })
    .catch(() => null)
  cache.set(typeID, promise)
  return promise
}

type TypeNameProps = {
  typeID: number
  fallback?: string
}

export const TypeName = ({ typeID, fallback }: TypeNameProps) => {
  const [name, setName] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    lookupName(typeID).then((value) => {
      if (active) setName(value)
    })
    return () => {
      active = false
    }
  }, [typeID])

  return <>{name ?? fallback ?? `#${typeID}`}</>
}
