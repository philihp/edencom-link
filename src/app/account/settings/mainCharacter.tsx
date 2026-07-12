'use client'

import { useState } from 'react'

import { setMainCharacter } from './actions'
import Dot from './dot'

type Character = { id: string; name: string }

// Dropdown picker for the account's main character. Saves on change via the
// server action and shows a colored status Dot for feedback.
const MainCharacter = ({ characters, mainId }: { characters: Character[]; mainId: string | null }) => {
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')

  const onChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const result = await setMainCharacter(e.target.value)
    if (result.error) {
      setColor('#FF0000')
      setResponse(result.error)
      return
    }
    setColor('#00AF00')
    setResponse('Main character updated')
  }

  return (
    <>
      <h2>Main character</h2>
      {characters.length === 0 ? (
        <p>Add a character to choose your main.</p>
      ) : (
        <>
          <p>Choose which of your characters represents this account.</p>
          <select defaultValue={mainId ?? ''} onChange={onChange}>
            <option value="" disabled>
              Select a character…
            </option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p>{response && <Dot color={color} response={response} />}</p>
        </>
      )}
    </>
  )
}

export default MainCharacter
