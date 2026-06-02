'use client'

import { Suspense, use } from 'react'

type TypeNameProps = {
  id: number
  promise: Promise<Record<number, string>>
  // Optional player-assigned name (e.g. a ship/container's custom name). When it
  // differs from the type name, both are shown: "Custom Name (Type)".
  name?: string | null
}

const Resolved = ({ id, promise, name }: TypeNameProps) => {
  const names = use(promise)
  const type = names[id] ?? `#${id}`
  if (name && name !== type)
    return (
      <>
        {name} <span style={{ color: 'var(--ink-faint)' }}>({type})</span>
      </>
    )
  return <>{type}</>
}

export const TypeName = ({ id, promise, name }: TypeNameProps) => (
  // A type/item name is always dynamic, item-specific text, so it owns the serif
  // face (see globals.css) rather than relying on each caller to add it.
  <span className="serif">
    <Suspense fallback={name ?? `#${id}`}>
      <Resolved id={id} promise={promise} name={name} />
    </Suspense>
  </span>
)
