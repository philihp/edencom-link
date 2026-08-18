// Who a Link is currently issued to, as one short phrase for the listing.
// Mirrors the Revision 3 audience reading (docs/sharing-layer/01-asset-share-table.md):
// `enabled` is what keeps "not issued yet" distinct from "issued to everyone",
// and an enabled row with no corporations, no alliances and no secret IS the
// public state. Audiences compose, so a row can name corporations AND carry a
// signed link; every part that applies is reported.
export type IssuanceRow = {
  enabled: boolean
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

export const issuanceLabel = (link: IssuanceRow): string => {
  if (!link.enabled) return 'Not issued'
  const corporations = link.corporation_ids?.length ?? 0
  const alliances = link.alliance_ids?.length ?? 0
  if (corporations === 0 && alliances === 0 && link.secret == null) return 'Everyone'
  const parts = [
    corporations > 0 ? plural(corporations, 'corporation') : null,
    alliances > 0 ? plural(alliances, 'alliance') : null,
    link.secret != null ? 'signed link' : null,
  ].filter((p): p is string => p !== null)
  return parts.join(' · ')
}
