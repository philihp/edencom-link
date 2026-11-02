// The pure seams of the ship-memory tools (memoryTools.ts; docs/ship-memory.md
// "MCP tools"): which hull a name picks out, how far a share row reaches, and
// whether the memory a caller holds was written before their time. No I/O.
import { pickOne, type Picked } from '../../link/match.ts'
import { latestPerItem } from '../../ship/[itemId]/lastSeen.ts'
import type { OwnerKind } from '../../ship/memory/dossier.ts'

// How often the owner's hangar is listed, so the origin match knows how far
// back before the debut the event could have happened: character-assets runs
// every 6h, corp-assets daily.
export const EXTRACT_INTERVAL_MS: Record<OwnerKind, number> = {
  character: 6 * 60 * 60 * 1000,
  corporation: 24 * 60 * 60 * 1000,
}

// ── which hull ────────────────────────────────────────────────────────────

export type HullRow = {
  item_id: number | string
  name: string | null
  type_id: number | string
  is_current: boolean
  valid_until: string
}

// An item id typed as a number, or a number-like string, is the hull itself.
export const parseItemId = (ship: string): number | null => (/^\d{5,}$/.test(ship.trim()) ? Number(ship.trim()) : null)

// A name over the caller's own hulls, current and dead: one version per item
// (the newest), then the link tools' rule — id, exact name, unique substring,
// ambiguity refused. The candidates are already name-filtered by the loader's
// ilike, so the substring step is what decides between "Kettle" and "Rusty
// Kettle II".
export const pickHull = (query: string, rows: HullRow[]): Picked => {
  const candidates = latestPerItem(rows)
    .filter((r) => r.name != null && r.name.trim() !== '')
    .map((r) => ({ id: String(r.item_id), name: `${r.name}${r.is_current ? '' : ' (no longer held)'}` }))
  return pickOne(query, candidates, 'ship')
}

// ── who can read ──────────────────────────────────────────────────────────

export type ShareRowLike = {
  item_id: number | string
  corporation_ids: Array<number | string>
  alliance_ids: Array<number | string>
  secret: string | null
  show_as_main?: boolean
}

export type Reader = {
  // What the share row names: the hull, a container above it, or its place.
  subject: 'ship' | 'container' | 'place'
  subject_id: number
  reach: 'everyone' | 'corporations_and_alliances' | 'link_holders' | 'nobody'
  corporation_ids: number[]
  alliance_ids: number[]
  // Besides any audience, anyone holding the signed link.
  by_link: boolean
  // The share hides the holder behind the account's main character; the
  // memory panel is hidden on such a share (docs/ship-memory.md, Display).
  hides_holder: boolean
}

// How far one share row reaches, in the Revision 3 shape: fully public when
// it names no one and carries no secret; otherwise the corporations and
// alliances it pins, plus the link when it carries a secret.
export const describeReader = (row: ShareRowLike, subject: Reader['subject']): Reader => {
  const corporation_ids = row.corporation_ids.map(Number)
  const alliance_ids = row.alliance_ids.map(Number)
  const named = corporation_ids.length > 0 || alliance_ids.length > 0
  const by_link = row.secret != null
  const reach =
    !named && !by_link ? 'everyone' : named ? 'corporations_and_alliances' : by_link ? 'link_holders' : 'nobody'
  return {
    subject,
    subject_id: Number(row.item_id),
    reach,
    corporation_ids,
    alliance_ids,
    by_link,
    hides_holder: row.show_as_main === true,
  }
}

// Which subject a share row's item is, given the hull, the containers above
// it (nearest first) and its place.
export const subjectOf = (
  itemId: number | string,
  hullId: number,
  containerIds: number[],
  placeId: number | null
): Reader['subject'] | null => {
  const id = Number(itemId)
  if (id === hullId) return 'ship'
  if (containerIds.includes(id)) return 'container'
  if (placeId != null && id === placeId) return 'place'
  return null
}

// ── before you ────────────────────────────────────────────────────────────

export type MemoryVersionLike = { written_by: string | null; valid_from: string }

export type Inheritance = {
  // The current text was written by another account, so the voice is theirs
  // to continue, not to start.
  inherited: boolean
  written_by_you: boolean
  // The memory's earliest write the caller can see came before the hull's
  // earliest version in the caller's own data: there are chapters from
  // before the caller's time.
  predates_your_record: boolean
  memory_first_written: string | null
  your_first_sighting: string
}

export const inheritance = (
  current: MemoryVersionLike | null,
  visibleVersions: MemoryVersionLike[],
  yourFirstSighting: string,
  userId: string | null
): Inheritance => {
  const first = visibleVersions
    .map((v) => v.valid_from)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0]
  const writtenByYou = current != null && current.written_by != null && current.written_by === userId
  return {
    inherited: current != null && !writtenByYou,
    written_by_you: writtenByYou,
    predates_your_record: first != null && new Date(first).getTime() < new Date(yourFirstSighting).getTime(),
    memory_first_written: first ?? null,
    your_first_sighting: yourFirstSighting,
  }
}

// ── writing ───────────────────────────────────────────────────────────────

// The storage's own limits (the check constraint on item_memory_over_time),
// tested here so the tool can say what is wrong instead of relaying a
// constraint name.
export const MAX_MEMORY_LENGTH = 20_000
export const MAX_AUTHOR_LENGTH = 200

export type Validated = { ok: true; body: string } | { ok: false; message: string }

export const validateMemory = (memory: string): Validated => {
  if (memory.trim() === '') return { ok: false, message: "The memory is blank. Write the ship's text, in markdown." }
  if (memory.length > MAX_MEMORY_LENGTH) {
    return {
      ok: false,
      message: `The memory is ${memory.length.toLocaleString('en-US')} characters; the most a ship keeps is ${MAX_MEMORY_LENGTH.toLocaleString('en-US')}. Shorten it (the older chapters can be summarised, not dropped).`,
    }
  }
  return { ok: true, body: memory }
}

// The author stamped on the version: the client's name where it gives one,
// else 'mcp' (the function's own default).
export const authorOf = (author: string | undefined): string => {
  const trimmed = (author ?? '').trim()
  return trimmed === '' ? 'mcp' : trimmed.slice(0, MAX_AUTHOR_LENGTH)
}

export type WriteError = { code?: string | null; message?: string | null; hint?: string | null }

// What item_memory_write()'s refusals mean to the caller, by SQLSTATE: 42501
// is "not held", PT409 is "changed since you read it" (read again; never
// merge), 23514 is the body constraint. Anything else is relayed as is.
export const writeFailure = (error: WriteError, itemId: number): string => {
  switch (error.code) {
    case '42501':
      return `You do not hold item #${itemId} now, so you cannot write its memory. Only the character or corporation holding a ship writes it; a ship that was sold or given away took its memory with it.`
    case 'PT409':
      return `The memory of item #${itemId} changed since you read it. Call recall_ship again, read the current text, and write on top of it with its version_id as based_on. Do not merge the two texts yourself.`
    case '23514':
      return `The memory was refused by the storage: it must not be blank and must be at most ${MAX_MEMORY_LENGTH.toLocaleString('en-US')} characters.`
    default:
      return `Writing the memory failed: ${error.message ?? 'unknown error'}${error.hint ? ` (${error.hint})` : ''}`
  }
}
