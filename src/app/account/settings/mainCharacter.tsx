'use client'

import { useState } from 'react'

import { setMainCharacter } from './actions'
import Dot from './dot'
import styles from './settings.module.css'

type Character = { id: string; name: string; characterId: number | null }

// The main-character panel body: portrait and name of the current main as the
// readout, the picker beside it. Saves on change via the server action and
// shows a colored status Dot for feedback.
const MainCharacter = ({ characters, mainId }: { characters: Character[]; mainId: string | null }) => {
  const [selectedId, setSelectedId] = useState(mainId ?? characters[0]?.id ?? '')
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('var(--ink)')

  const selected = characters.find((c) => c.id === selectedId) ?? null

  const onChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedId(e.target.value)
    const result = await setMainCharacter(e.target.value)
    if (result.error) {
      setColor('var(--danger)')
      setResponse(result.error)
      return
    }
    setColor('var(--ok)')
    setResponse('Main character updated')
  }

  if (characters.length === 0) {
    return <div className={styles.note}>Add a character to choose your main.</div>
  }

  return (
    <>
      <div className={styles.mainRow}>
        {selected?.characterId ? (
          <img
            className={styles.mainAvatar}
            src={`https://images.evetech.net/characters/${selected.characterId}/portrait?size=64`}
            alt={selected.name}
          />
        ) : (
          <span className={styles.mainAvatar} aria-hidden="true" />
        )}
        <span className={styles.mainText}>
          <span className={styles.mainName}>{selected?.name ?? '—'}</span>
        </span>
        <select value={selectedId} onChange={onChange}>
          <option value="" disabled>
            Select a character…
          </option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {response && (
        <div className={styles.feedback}>
          <Dot color={color} response={response} />
        </div>
      )}
    </>
  )
}

export default MainCharacter
