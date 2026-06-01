'use client'

import { Suspense, use } from 'react'

type TypeNameProps = {
  id: number
  promise: Promise<Record<number, string>>
}

const Resolved = ({ id, promise }: TypeNameProps) => {
  const names = use(promise)
  return <>{names[id] ?? `#${id}`}</>
}

export const TypeName = ({ id, promise }: TypeNameProps) => (
  // A type/item name is always dynamic, item-specific text, so it owns the serif
  // face (see globals.css) rather than relying on each caller to add it.
  <span className="serif">
    <Suspense fallback={`#${id}`}>
      <Resolved id={id} promise={promise} />
    </Suspense>
  </span>
)
