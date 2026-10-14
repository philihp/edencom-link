import { append, map, pipe, reject } from 'ramda'

import type { Crumb } from '../assetPath'

// The what-sharing-means line every asset Share dialog opens with — an item,
// a ship, or a place — as one sentence naming exactly what is shared:
//
//   Share items in locationID '<id>' (<place> › <container>) that are owned by <owner>.
//
// Pure, so the wording is testable.

export type ShareHintOwner = { kind: 'you' } | { kind: 'corporation'; name: string }

// The path from the root place down to the subject. The breadcrumb leads with
// navigation that isn't where the item is — the Assets root and the region ›
// system prefix — so those drop out, leaving the station or structure (or the
// system, for something floating in space) and the containers under it.
export const sharePath = (crumbs: Crumb[], current: string): string[] =>
  pipe(
    reject((crumb: Crumb) => crumb.nav === true),
    map((crumb: Crumb) => crumb.label),
    append(current)
  )(crumbs)

const ownedBy = (owner: ShareHintOwner) =>
  owner.kind === 'you'
    ? 'you'
    : `${owner.name} and shared on behalf of you. If you lose access to your corp, the share will be disabled`

export const shareHint = (locationId: string, path: string[], owner: ShareHintOwner) =>
  `Share items in locationID '${locationId}' (${path.join(' › ')}) that are owned by ${ownedBy(owner)}.`
