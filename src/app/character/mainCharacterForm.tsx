'use client'

import { useState } from 'react'

// Wraps the character list's radios and the "Set as Main" button. The button
// stays disabled until the player picks a character other than their current
// main (`mainId`, null when none is set yet). The radios are server-rendered as
// `children`; their change events bubble to the form, where we re-read the
// selected value from the form data.
const MainCharacterForm = ({
  mainId,
  hasCharacters,
  action,
  children,
}: {
  mainId: string | null
  hasCharacters: boolean
  action: (formData: FormData) => void | Promise<void>
  children: React.ReactNode
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(mainId)

  const onChange = (e: React.FormEvent<HTMLFormElement>) => {
    const value = new FormData(e.currentTarget).get('main')
    setSelectedId(typeof value === 'string' ? value : null)
  }

  return (
    <form onChange={onChange}>
      {children}
      {hasCharacters && (
        <button formAction={action} disabled={selectedId === mainId}>
          Set as Main
        </button>
      )}
    </form>
  )
}

export default MainCharacterForm
