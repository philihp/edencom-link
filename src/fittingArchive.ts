// The archive file format, and the pure rules for getting a fitting into and
// out of one.
//
// An archive file is *exactly* ESI's own fitting object — the shape
// GET /characters/{id}/fittings/ returns and POST /characters/{id}/fittings/
// accepts:
//
//   { "fitting_id": 12, "name": "Doctrine Hurricane", "description": "",
//     "ship_type_id": 24702,
//     "items": [{ "type_id": 2048, "flag": "LoSlot0", "quantity": 1 }] }
//
// Nothing of ours is added to it. That is the whole point of the archive: the
// file a player drags out of the FUSE mount into a folder (or a git repo, or a
// Dropbox) is CCP's own representation of the fit, readable by anything that
// speaks ESI fittings, and restorable by replaying it back at POST. `fitting_id`
// is carried because ESI carries it, and ignored on restore — the game mints a
// new one, so the id is a frame number, never the identity of the fit.
//
// Identity is `contentHash` instead: sha256 over the fit's meaning. It answers
// the two questions the write path has to get right — "is this fit already
// saved in game?" (don't POST a duplicate) and "is the fit I'm about to DELETE
// still the one I stored?" (never delete a version nobody has a copy of).
import { createHash } from 'node:crypto'

export type FittingItem = {
  type_id: number
  flag: string
  quantity: number
}

/** A fit's content, with no id: everything POST /fittings/ takes. */
export type FittingBody = {
  name: string
  description: string
  ship_type_id: number
  items: FittingItem[]
}

/** A fit as it appears in an archive file, or in a GET /fittings/ response. */
export type ArchiveFitting = FittingBody & { fitting_id: number }

// CCP's limits on the POST body, from the fittings endpoint's own schema. A
// file that busts one of these would be rejected by ESI with a 400 whose body
// we would then have to explain; refusing it here gives the player a message
// that names the field instead.
export const MAX_NAME_LENGTH = 50
export const MAX_DESCRIPTION_LENGTH = 500

/** How many fittings one character may have saved in game at once. */
export const FITTING_SLOTS = 500

// Normalized module list: the three fields a fit is made of, sorted by slot
// then type so two sightings of an unchanged fit compare (and hash) equal
// regardless of the order ESI happened to serialize them in. Deliberately the
// same normalization the character-fittings extract applies
// (src/jobs/characterFittings.js) — a hash of a stored row and a hash of a
// freshly fetched one have to agree or the dedupe and the verify-before-delete
// both break.
export const normalizeItems = (items: unknown): FittingItem[] =>
  (Array.isArray(items) ? items : [])
    .map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>
      return {
        type_id: Number(item.type_id),
        flag: String(item.flag ?? ''),
        quantity: Number(item.quantity ?? 1),
      }
    })
    .sort((a, b) => {
      // Plain codepoint order, not localeCompare: the extract job sorts on the
      // same key with ramda's sortBy, and a hash that disagrees with the job's
      // stored order across locales would be a hash that changes by machine.
      const [x, y] = [`${a.flag}:${a.type_id}`, `${b.flag}:${b.type_id}`]
      return x < y ? -1 : x > y ? 1 : 0
    })

/**
 * The durable identity of a fit's *content*: sha256 over the normalized
 * (ship, name, description, items) tuple, hex. Not over the JSON file, whose
 * key order and whitespace say nothing about the fit.
 */
export const contentHash = (fit: FittingBody): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        Number(fit.ship_type_id),
        fit.name ?? '',
        fit.description ?? '',
        normalizeItems(fit.items).map((i) => [i.type_id, i.flag, i.quantity]),
      ])
    )
    .digest('hex')

/** The archive file for one stored fitting: ESI's object, key order and all. */
export const toArchiveFitting = (row: {
  fitting_id: number | string
  name: string | null
  description: string | null
  ship_type_id: number | string
  items: unknown
}): ArchiveFitting => ({
  fitting_id: Number(row.fitting_id),
  name: row.name ?? '',
  description: row.description ?? '',
  ship_type_id: Number(row.ship_type_id),
  items: normalizeItems(row.items),
})

export type ParseResult = { ok: true; fitting: FittingBody } | { ok: false; error: string }

const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0

/**
 * Validate a restore: an archive file, on its way back into the game.
 *
 * Everything here is checked against the file the player hands us rather than
 * against anything we stored, because an archive file is an ordinary file on
 * their disk — it can be hand-edited, truncated by a bad copy, or be some
 * other program's JSON that happens to have landed in the folder. A restore
 * that would make ESI answer 400 is refused here, naming the field.
 *
 * Unknown keys (`fitting_id` among them) are dropped rather than rejected, so
 * a file that came straight out of the mount round-trips and a file carrying
 * some other tool's annotations still restores.
 */
export const parseArchiveFitting = (text: string): ParseResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Not valid JSON. An archived fitting is the JSON object ESI returns for a fitting.' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a JSON object describing one fitting.' }
  }
  const fit = parsed as Record<string, unknown>

  const name = typeof fit.name === 'string' ? fit.name.trim() : ''
  if (name.length === 0) return { ok: false, error: 'Fitting has no name.' }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Fitting name is longer than the ${MAX_NAME_LENGTH} characters EVE allows.` }
  }

  const description = typeof fit.description === 'string' ? fit.description : ''
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Fitting description is longer than the ${MAX_DESCRIPTION_LENGTH} characters EVE allows.`,
    }
  }

  const shipTypeId = Number(fit.ship_type_id)
  if (!isPositiveInt(shipTypeId)) return { ok: false, error: 'Missing or invalid ship_type_id.' }

  if (!Array.isArray(fit.items)) return { ok: false, error: 'Missing items array.' }
  const items = normalizeItems(fit.items)
  const bad = items.find((i) => !isPositiveInt(i.type_id) || i.flag === '' || !isPositiveInt(i.quantity))
  if (bad) {
    return { ok: false, error: 'Every item needs a positive type_id, a slot flag, and a positive quantity.' }
  }

  return { ok: true, fitting: { name, description, ship_type_id: shipTypeId, items } }
}
