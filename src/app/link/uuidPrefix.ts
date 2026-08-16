// Truncated link ids, both directions — pure string work only, so the node
// test runner can cover it without a client.
//
// Accept side (uuidPrefixRange): a truncated id in the /link/[id] path is any
// prefix of the canonical uuid formatting, at least 8 hex digits long
// (shorter invites typo-matches and shrinks the scan space for probing which
// ids exist). Postgres compares uuids bytewise — the same order as their hex
// strings — so a prefix becomes a closed range: pad the missing digits with 0
// for the low bound and f for the high, and every uuid starting with the
// prefix falls between them. That keeps the lookup an index range scan
// instead of a ::text LIKE.
//
// Emit side (shortestUuidPrefix): the inverse — the shortest such prefix that
// still resolves back to this id, git-style, given the ids it has to beat.
const UUID_TEMPLATE = '00000000-0000-0000-0000-000000000000'
const MIN_HEX_DIGITS = 8
// The canonical 8-4-4-4-12 grouping, for re-inserting dashes into bare hex.
const GROUP_SIZES = [8, 4, 4, 4, 12]

export type UuidRange = { low: string; high: string }

export const uuidPrefixRange = (param: string): UuidRange | null => {
  const prefix = param.toLowerCase()
  if (prefix.length > UUID_TEMPLATE.length) return null

  // A valid prefix agrees with the canonical shape position by position:
  // dashes exactly where the template has them, hex everywhere else.
  const chars = prefix.split('')
  const shapeOk = chars.every((ch, i) => (UUID_TEMPLATE[i] === '-' ? ch === '-' : /[0-9a-f]/.test(ch)))
  if (!shapeOk) return null
  if (chars.filter((ch) => ch !== '-').length < MIN_HEX_DIGITS) return null

  const rest = UUID_TEMPLATE.slice(prefix.length)
  return { low: prefix + rest, high: prefix + rest.replace(/0/g, 'f') }
}

const stripDashes = (id: string): string => id.toLowerCase().replace(/-/g, '')

// Bare hex digits → the canonical formatting truncated to them: dashes
// re-inserted at the 8-4-4-4-12 boundaries, never trailing.
const formatHexPrefix = (hex: string): string =>
  GROUP_SIZES.reduce(
    ({ groups, rest }, size) =>
      rest === '' ? { groups, rest } : { groups: [...groups, rest.slice(0, size)], rest: rest.slice(size) },
    { groups: [] as string[], rest: hex }
  ).groups.join('-')

// The shortest canonical-format prefix of `id` (≥ 8 hex digits) that no id in
// `contested` shares, or the full id when nothing shorter disambiguates.
// The caller decides which ids are contested — for links that's only ones
// created no later than `id`, since resolution takes the oldest-created match
// and anything newer loses the tie on its own.
export const shortestUuidPrefix = (id: string, contested: string[]): string => {
  const hex = stripDashes(id)
  const others = contested.map(stripDashes)
  const lengths = Array.from({ length: hex.length - MIN_HEX_DIGITS }, (_, i) => MIN_HEX_DIGITS + i)
  const n = lengths.find((len) => !others.some((o) => o.startsWith(hex.slice(0, len))))
  return n === undefined ? id.toLowerCase() : formatHexPrefix(hex.slice(0, n))
}
