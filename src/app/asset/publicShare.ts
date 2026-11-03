import { filter, groupBy, keys, sortBy } from 'ramda'

// The pure rules of a fully public asset share, as the bare URL reads it
// (docs/sharing-layer/01-asset-share-table.md, row state (d)). A public share
// has no URL of its own — it is the row naming nobody — so /ship/<id> and
// /asset/<id> themselves are the link, and a signed-out visitor is let in when
// a public row covers the item. The resolver in ./access.ts walks the item's
// ancestry for candidate rows; this picks which one, if any, opens the page.

export type ShareAudience = {
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
}

export type PublicShareRow = ShareAudience & { item_id: number | string }

// The row state that is "everyone": no link secret and no audience named.
// Mirrors share_audience_matches()'s public clause in SQL, and is what the
// dialog's Public checkbox reads back (shareData.ts).
export const isPublicShare = (row: ShareAudience): boolean =>
  row.secret == null && (row.corporation_ids ?? []).length === 0 && (row.alliance_ids ?? []).length === 0

// Which public share opens an item, given every share row whose subject is the
// item or one of its ancestors (`chain`, nearest first) and a grantor key per
// row (an account, or a corporation). The nearest subject wins, so an item's
// own public share takes precedence over its container's. Null when none is
// public — or when the public rows belong to MORE THAN ONE grantor: a place
// (a station, a system) can carry public shares from several accounts, and
// the bare URL can show only one hangar, so rather than show one person's
// items under a URL another handed out, it shows nobody's. A signed link
// never has this problem: its signature names the row.
export const pickPublicShare = <T extends PublicShareRow>(
  rows: T[],
  chain: Array<number | string>,
  grantorOf: (row: T) => string
): T | null => {
  const open = filter(isPublicShare, rows)
  if (open.length === 0) return null
  if (keys(groupBy(grantorOf, open)).length > 1) return null
  const ids = chain.map(String)
  return sortBy((row: T) => ids.indexOf(String(row.item_id)), open)[0]
}
