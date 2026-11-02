// Which version of a ship's memory a page shows (docs/ship-memory.md,
// "Display"), as a pure rule over the item's version rows. The holder's page
// shows the current text. A share link to a hull the sharer no longer holds
// shows the memory as it stood when the hull was last seen, so a text written
// after the sale (by the buyer) never reaches the seller's old link. No I/O.

export type MemoryVersion = {
  id: number | string
  body: string
  author: string
  written_by: string | null
  is_current: boolean
  valid_from: string
  valid_until: string
}

const ms = (iso: string): number => new Date(iso).getTime()

// The version in force at `asOf`: opened at or before it, and not closed by
// then (an open row's valid_until is only its debut and is not consulted).
// With no `asOf`, the current version. Null when none applies.
export const versionAsOf = <T extends MemoryVersion>(rows: T[], asOf: string | null): T | null => {
  if (asOf == null) return rows.find((r) => r.is_current) ?? null
  const at = ms(asOf)
  return (
    rows
      .filter((r) => ms(r.valid_from) <= at && (r.is_current || ms(r.valid_until) > at))
      .sort((a, b) => ms(b.valid_from) - ms(a.valid_from))[0] ?? null
  )
}

export type MemoryMeta = {
  // Versions on record up to the one shown (every write is a version, so
  // this is "written N times").
  versions: number
  // The most recent write at or before the one shown.
  lastWritten: string
}

// "written N times, last on …" for the version shown: the versions opened at
// or before it. Later versions (after a sale, on the seller's old link) are
// not counted, since the page does not show them.
export const memoryMeta = (rows: MemoryVersion[], shown: MemoryVersion): MemoryMeta => ({
  versions: rows.filter((r) => ms(r.valid_from) <= ms(shown.valid_from)).length,
  lastWritten: shown.valid_from,
})
