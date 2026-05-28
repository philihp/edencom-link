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
  <Suspense fallback={`#${id}`}>
    <Resolved id={id} promise={promise} />
  </Suspense>
)
