import { filter, map, pipe } from 'ramda'

import type { Owner, Owners } from '../ownerFilter'

// Who may share a PLACE — a station, structure or system — and what the dialog
// says when they do (docs/sharing-layer/15-place-share.md). Pure, so the one
// decision that matters is testable: a place share covers only its grantor's
// own items there, so a page offers one share per owner of the caller's that
// holds something at the place, and never one for an owner who merely shared
// their items with the caller.

export type PlaceGrantor =
  | { kind: 'character'; registrationId: string; name: string }
  | { kind: 'corporation'; corporationId: number; name: string }

// The caller's owners holding a root item here, in the owner picker's order:
// characters first, then corporations. `owners` is the caller's own (the
// registration read RLS scopes to the account), so a root an audience member
// sees through someone else's share drops out here.
export const placeGrantors = (rootOwnerIds: Iterable<string>, owners: Owners): PlaceGrantor[] => {
  const held = new Set(rootOwnerIds)
  const holding = filter((o: Owner) => held.has(o.id))
  return [
    ...pipe(
      holding,
      map((o: Owner): PlaceGrantor => ({ kind: 'character', registrationId: o.id, name: o.name }))
    )(owners.characters),
    ...pipe(
      holding,
      map((o: Owner): PlaceGrantor => ({ kind: 'corporation', corporationId: Number(o.id), name: o.name }))
    )(owners.corporations),
  ]
}

// What the Share button and the dialog heading call the subject.
export const placeShareSubject = (grantor: PlaceGrantor) => `${grantor.name}’s items here`

// The what-sharing-means line. A corporation's share outlives whoever started
// it, so it says who can stop it, as the corp item dialog does.
export const placeShareHint = (grantor: PlaceGrantor, placeName: string) =>
  `Whoever you share with can see ${grantor.name}’s items at ${placeName} and everything inside them, live, until ${
    grantor.kind === 'corporation' ? `a member of ${grantor.name} stops sharing` : 'you stop sharing'
  }. Nobody else’s items here are included.`
