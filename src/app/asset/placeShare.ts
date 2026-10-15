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

export type PlaceGrantor =
  | { kind: 'character' }
  // `ownsPlace`: the place is this corporation's own structure, so its share
  // row covers the structure's tree too (docs/sharing-layer/17-share-subjects.md).
  | { kind: 'corporation'; corporationId: number; name: string; ownsPlace?: boolean }

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

// The grantors a SUBJECT offers (docs/sharing-layer/17-share-subjects.md): the
// owners with roots at it, plus — when the subject is itself a corporation's
// item, a structure it owns — that corporation, whose place share and item
// share are one row. The union is one list, so a corporation owning the
// structure and holding roots at it is one option, flagged `ownsPlace`. A
// character-owned subject takes the item share instead, never this.
export const subjectGrantors = (
  owningCorporationId: number | null,
  rootOwnerIds: Iterable<string>,
  owners: Owners
): PlaceGrantor[] =>
  map(
    (g: PlaceGrantor): PlaceGrantor =>
      g.kind === 'corporation' && g.corporationId === owningCorporationId ? { ...g, ownsPlace: true } : g,
    placeGrantors(owningCorporationId == null ? rootOwnerIds : [String(owningCorporationId), ...rootOwnerIds], owners)
  )

export const grantorKey = (grantor: PlaceGrantor) =>
  grantor.kind === 'character' ? 'characters' : `corp-${grantor.corporationId}`

// What the chooser calls an option.
export const placeShareSubject = (grantor: PlaceGrantor) =>
  grantor.kind === 'character'
    ? 'Your characters’ items here'
    : grantor.ownsPlace
      ? `${grantor.name}’s structure and items here`
      : `${grantor.name}’s items here`

// What the chooser's tab calls an option: the grantor alone, since the
// heading above already says what is shared.
export const placeShareTab = (grantor: PlaceGrantor) =>
  grantor.kind === 'character' ? 'Your characters' : grantor.name
