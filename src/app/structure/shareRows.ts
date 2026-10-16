import { filter } from 'ramda'

import type { ShareState } from '../asset/shareData'

// The pure rules of a corp_structure_share row, as the pages and the signed
// link read it (docs/sharing-layer/12-structure-share.md). Mirrors
// structure_share_matches() in SQL: a seeded row grants only through its
// alliance list, a tenants row names someone, and only an unseeded row naming
// nobody is fully public.

export type StructureShareRow = {
  id: string
  corporation_id: number | string
  // Null = every structure the corporation owns.
  structure_id: number | string | null
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
  tenants: boolean
  seeded_default: boolean
}

// The row state that is "everyone": names no corporation, alliance, link or
// tenant, and is not the seeded alliance default (which, with an empty
// alliance list, names nobody rather than everyone).
export const isPublicStructureShare = (row: StructureShareRow): boolean =>
  row.secret == null &&
  (row.corporation_ids ?? []).length === 0 &&
  (row.alliance_ids ?? []).length === 0 &&
  !row.tenants &&
  !row.seeded_default

// The rows of a corporation that cover one structure: the structure's own row
// and the corporation-wide (null-subject) one.
export const coveringStructureShares = <T extends { structure_id: number | string | null }>(
  rows: T[],
  structureId: string
): T[] => filter((row: T) => row.structure_id == null || String(row.structure_id) === structureId, rows)

// A share row → the dialog's view of it. `shareParam` is signed by the caller
// (signing needs the secret and the deployment salt, server-only), so it is
// handed in rather than derived here.
export const structureShareState = (row: StructureShareRow, shareParam: string | null = null): ShareState => ({
  corporationIds: (row.corporation_ids ?? []).map(Number),
  allianceIds: (row.alliance_ids ?? []).map(Number),
  hasLink: row.secret != null,
  shareParam: row.secret != null ? shareParam : null,
  isPublic: isPublicStructureShare(row),
  tenants: row.tenants,
})
