import { filter, map, pipe } from 'ramda'

import type { Owner, Owners } from '../ownerFilter'

// Who may share a PLACE — a station, structure or system — and what the dialog
// says when they do (docs/sharing-layer/15-place-share.md). Pure, so the
// decisions that matter are testable.
//
// A place share is either a CHARACTER share — everything any character of the
// caller's account holds there, one row however many characters — or a
// CORPORATION share, per corporation. The page offers one Share button; the
// dialog offers a choice only when more than one kind has something here, and
// otherwise assumes the only one that does.

export type PlaceGrantor = { kind: 'character' } | { kind: 'corporation'; corporationId: number; name: string }

// The shares the caller could make here, in the order the dialog lists them:
// the account's characters first, then each corporation holding a root.
// `owners` is the caller's own (the registration read RLS scopes to the
// account), so a root an audience member sees through someone else's share
// drops out here.
export const placeGrantors = (rootOwnerIds: Iterable<string>, owners: Owners): PlaceGrantor[] => {
  const held = new Set(rootOwnerIds)
  const holding = filter((o: Owner) => held.has(o.id))
  const characters = holding(owners.characters)
  return [
    ...(characters.length > 0 ? [{ kind: 'character' } as PlaceGrantor] : []),
    ...pipe(
      holding,
      map((o: Owner): PlaceGrantor => ({ kind: 'corporation', corporationId: Number(o.id), name: o.name }))
    )(owners.corporations),
  ]
}

export const grantorKey = (grantor: PlaceGrantor) =>
  grantor.kind === 'character' ? 'characters' : `corp-${grantor.corporationId}`

// What the chooser calls an option.
export const placeShareSubject = (grantor: PlaceGrantor) =>
  grantor.kind === 'character' ? 'Your characters’ items here' : `${grantor.name}’s items here`

// The what-sharing-means line. A corporation's share outlives whoever started
// it, so it says who can stop it, as the corp item dialog does.
export const placeShareHint = (grantor: PlaceGrantor, placeName: string) =>
  grantor.kind === 'character'
    ? `Whoever you share with can see everything your characters own at ${placeName}, and everything inside it, live, until you stop sharing. Corporation-owned items and other players’ items here are not included.`
    : `Whoever you share with can see ${grantor.name}’s items at ${placeName} and everything inside them, live, until a member of ${grantor.name} stops sharing. Nobody else’s items here are included.`
