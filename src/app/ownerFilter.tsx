'use client'

import { usePersist } from './market/usePersist'

// An "owner" is anything assets/jobs can belong to: one of the user's linked
// characters (keyed by registration uuid) or a corporation those characters
// belong to (keyed by its EVE corporation id). The two id spaces can't
// collide, so a single string value identifies either in the filter.
export type Owner = { id: string; name: string }
export type Owners = { characters: Owner[]; corporations: Owner[] }

export const ALL_OWNERS = ''

export const ownerNames = (owners: Owners): Map<string, string> =>
  new Map([...owners.characters, ...owners.corporations].map((o) => [o.id, o.name]))

export const useOwnerFilter = (storageKey: string, owners: Owners) =>
  usePersist<string>(storageKey, ALL_OWNERS, (raw) =>
    raw === ALL_OWNERS || [...owners.characters, ...owners.corporations].some((o) => o.id === raw) ? raw : undefined
  )

type OwnerSelectProps = {
  owners: Owners
  value: string
  onChange: (id: string) => void
}

// Bare <select> so each page wraps it in its own label/styling.
export const OwnerSelect = ({ owners, value, onChange }: OwnerSelectProps) => (
  <select value={value} onChange={(e) => onChange(e.target.value)}>
    <option value={ALL_OWNERS}>All owners</option>
    <optgroup label="Characters">
      {owners.characters.map((c) => (
        <option key={`character-${c.id}`} value={c.id}>
          {c.name}
        </option>
      ))}
    </optgroup>
    {owners.corporations.length > 0 && (
      <optgroup label="Corporations">
        {owners.corporations.map((c) => (
          <option key={`corporation-${c.id}`} value={c.id}>
            {c.name}
          </option>
        ))}
      </optgroup>
    )}
  </select>
)
