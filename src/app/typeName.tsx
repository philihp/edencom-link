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
  // ESI uses the literal string "None" for singletons with no player-assigned
  // name (e.g. blueprints); don't show it as a prefix. Guards rows already
  // stored before fetchNames filtered it out.
  if (name && name !== 'None' && name !== type)
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
    <Suspense fallback={name && name !== 'None' ? name : `#${id}`}>
      <Resolved id={id} promise={promise} name={name} />
    </Suspense>
  </span>
)
