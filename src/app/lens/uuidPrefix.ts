// A truncated lens id in the /lens/[id] path: any prefix of the canonical
// uuid formatting, at least 8 hex digits long (shorter invites typo-matches
// and shrinks the scan space for probing which ids exist). Postgres compares
// uuids bytewise — the same order as their hex strings — so a prefix becomes
// a closed range: pad the missing digits with 0 for the low bound and f for
// the high, and every uuid starting with the prefix falls between them. That
// keeps the lookup an index range scan instead of a ::text LIKE.
const UUID_TEMPLATE = '00000000-0000-0000-0000-000000000000'
const MIN_HEX_DIGITS = 8

export type UuidRange = { low: string; high: string }

export const uuidPrefixRange = (param: string): UuidRange | null => {
  const prefix = param.toLowerCase()
  if (prefix.length > UUID_TEMPLATE.length) return null

  // A valid prefix agrees with the canonical shape position by position:
  // dashes exactly where the template has them, hex everywhere else.
  let hexDigits = 0
  for (let i = 0; i < prefix.length; i++) {
    if (UUID_TEMPLATE[i] === '-') {
      if (prefix[i] !== '-') return null
    } else if (/[0-9a-f]/.test(prefix[i])) {
      hexDigits += 1
    } else {
      return null
    }
  }
  if (hexDigits < MIN_HEX_DIGITS) return null

  const rest = UUID_TEMPLATE.slice(prefix.length)
  return { low: prefix + rest, high: prefix + rest.replace(/0/g, 'f') }
}
