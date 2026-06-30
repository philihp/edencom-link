// Resolves type names from the local SDE data baked in at build time (see
// src/buildSde.js / src/sdeTypes.ts) — never the stale `evesde` DB schema.
import { getSdeTypeNames } from '@/sdeTypes'

export const fetchTypeNames = async (typeIDs: Iterable<number>): Promise<Record<number, string>> => {
  const ids = Array.from(new Set([...typeIDs].filter((n) => Number.isFinite(n))))
  return getSdeTypeNames(ids)
}
