import { relativeTime } from '../../freshness.ts'

// When a ship was last seen, and what to make of it.
//
// A share link outlives the ship it was minted for: the hull gets sold,
// moved to an alt, or the extract stops running for that character. The
// share page keeps opening the ship as it was last seen rather than going
// dead, and says how long ago that was. The extract lists every character's
// assets at least daily, so a sighting older than a day means the ship is
// gone from that hangar (or the extract has not run), and the page raises an
// alert. No I/O: the loader (sharedShip.ts) reads the versions, this decides.

// The extract lists every character's assets at least once a day. A ship
// not seen for longer than that is missing, whatever its last row says.
export const OVERDUE_AFTER_MS = 24 * 60 * 60 * 1000

export type Sighting = {
  // The last extract that listed the ship. For a ship still in the hangar
  // that is the owner's last successful assets refresh (the reconcile writes
  // nothing to an unchanged row, so its own valid_until is only its debut);
  // for a vanished ship it is the row's valid_until, stamped by the run that
  // saw it gone.
  lastSeen: string
  // False once the newest version is closed: the ship is not in the hangar
  // now, and what the page shows is its last state.
  inHangar: boolean
}

type VersionRow = { item_id: number | string; is_current: boolean; valid_until: string }

// Not seen within the last day. Time alone decides: a ship that vanished an
// hour ago is not overdue yet, and a ship the extract has not listed for two
// days is overdue even while its row is still open.
export const isOverdue = (sighting: Sighting, now: number = Date.now()): boolean =>
  now - new Date(sighting.lastSeen).getTime() > OVERDUE_AFTER_MS

// "last seen 3 days ago", coarse like the freshness dot.
export const sightingText = (sighting: Sighting, now: number = Date.now()): string =>
  `last seen ${relativeTime(sighting.lastSeen, now)}`

// The sighting a version row stands for. `refreshedAt` is when the owner's
// assets were last pulled successfully; it is the sighting of an open row, and
// is ignored for a closed one, whose close is the last look. An open row with
// no refresh on record (a heartbeat the retention or a reset took) falls back
// to its own stamp rather than to nothing.
export const sightingOf = (
  row: Pick<VersionRow, 'is_current' | 'valid_until'>,
  refreshedAt: string | null = null
): Sighting => ({
  lastSeen: row.is_current && refreshedAt != null ? refreshedAt : row.valid_until,
  inHangar: row.is_current,
})

// Whether `a` is the newer version: an open row over a closed one, then the
// later last look.
const newer = (a: VersionRow, b: VersionRow): boolean =>
  a.is_current !== b.is_current ? a.is_current : new Date(a.valid_until) > new Date(b.valid_until)

// One version per item, the newest, out of rows that may hold several
// versions of the same item. The snapshot query for a vanished ship's
// contents reads the version table, where an item that changed twice inside
// the ship has two rows; the last closed is what was aboard. (An open row's
// valid_until is its debut, so this never compares an open row's stamp
// against a closed one's — is_current decides first.)
export const latestPerItem = <T extends VersionRow>(rows: T[]): T[] =>
  Object.values(
    rows.reduce<Record<string, T>>((held, row) => {
      const key = String(row.item_id)
      const current = held[key]
      held[key] = current === undefined || newer(row, current) ? row : current
      return held
    }, {})
  )
