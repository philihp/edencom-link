// A marshalled fit as a library entry (docs/fitting-marshal.md): what the
// /fitting matrix draws for a row of marshalled_fitting, beside the entries
// built from character_fitting. Pure, so the href, the sentinel owner and the
// label are pinned by a test rather than read off a rendered cell.
import { marshalledRoute } from '../../api/fittings/marshalledHandle.ts'
import type { FittingEntry } from '../fittingMatrix'

/**
 * The owner-filter value that selects the archive. Owner ids are EVE
 * character ids (digits) or corporation ids (digits), so a word can never
 * collide with a real owner — the same reason ALL_OWNERS is the empty string.
 */
export const MARSHALLED_OWNER = 'marshalled'

export type MarshalledLibraryRow = {
  content_hash: string
  name: string | null
  ship_type_id: number | string
}

export const marshalledEntry = (row: MarshalledLibraryRow): FittingEntry => ({
  href: marshalledRoute(row.content_hash),
  name: row.name || 'Unnamed fitting',
  shipTypeId: Number(row.ship_type_id),
  ownerId: MARSHALLED_OWNER,
  marshalled: true,
})
