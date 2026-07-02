'use client'

import { usePersist } from '../market/usePersist'
import styles from './assets.module.css'

export type Character = { id: string; name: string }

export const ALL_CHARACTERS = ''
// Shared across the index and the per-location page so a chosen character
// follows you when you drill in.
const STORAGE_KEY = 'assets.characterId'

export const useCharacterFilter = (characters: Character[]) =>
  usePersist<string>(STORAGE_KEY, ALL_CHARACTERS, (raw) =>
    raw === ALL_CHARACTERS || characters.some((c) => c.id === raw) ? raw : undefined
  )

type CharacterFilterProps = {
  characters: Character[]
  value: string
  onChange: (id: string) => void
}

export const CharacterFilter = ({ characters, value, onChange }: CharacterFilterProps) => (
  <label className={styles.filter}>
    Character:&nbsp;
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={ALL_CHARACTERS}>All characters</option>
      {characters.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  </label>
)
