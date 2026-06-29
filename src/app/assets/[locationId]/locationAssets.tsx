'use client'

import Link from 'next/link'

import retro from '../../retro.module.css'
import { TypeName } from '../../typeName'
import styles from '../assets.module.css'
import { ALL_CHARACTERS, CharacterFilter, useCharacterFilter, type Character } from '../characterFilter'
import { Quantity } from './quantity'

export type ItemRow = {
  itemId: string
  characterId: string
  typeId: number
  name: string | null
  quantity: number | string | null
  isSingleton: boolean | null
  flag: string | null
  contents: number
}

type LocationAssetsProps = {
  rows: ItemRow[]
  characters: Character[]
  typeNamesPromise: Promise<Record<number, string>>
}

export const LocationAssets = ({ rows, characters, typeNamesPromise }: LocationAssetsProps) => {
  const [characterId, setCharacterId] = useCharacterFilter(characters)

  const filtered = rows.filter((r) => characterId === ALL_CHARACTERS || r.characterId === characterId)
  const characterMap = new Map(characters.map((c) => [c.id, c.name]))

  return (
    <section>
      {filtered.length > 0 ? (
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>
                <label className={styles.filter}>
                  Character:&nbsp;
                  <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
                    <option value={ALL_CHARACTERS}>All characters</option>
                    {characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </th>
              <th>Item</th>
              <th className={retro.num}>Quantity</th>
              <th>Hangar</th>
              <th className={retro.num}>Contents</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={`item-${row.itemId}`}>
                <td>{characterMap.get(row.characterId) ?? row.characterId}</td>
                <td>
                  {row.contents > 0 ? (
                    // Ships and containers hold items — drill into them.
                    <Link href={`/assets/${row.itemId}`}>
                      <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                    </Link>
                  ) : (
                    <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                  )}
                </td>
                <td className={retro.num}>{row.isSingleton ? '—' : <Quantity value={row.quantity} />}</td>
                <td>{row.flag ?? '—'}</td>
                <td className={retro.num}>{row.contents > 0 ? row.contents : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No assets known at this location.</p>
      )}
    </section>
  )
}
