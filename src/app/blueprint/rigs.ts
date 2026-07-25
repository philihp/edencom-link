// Which Upwell rigs give a blueprint a material bonus, and the inverse test —
// does *this* rig cover *that* product. Both read the vendored eveship.fit
// modifier tables under [typeID]/: a rig's material modifier carries a
// filterID, and each filter enumerates the group/category ids it covers, so a
// rig applies to a product exactly when one of the product's filters lists it.
//
// Rigs whose material modifier has no filterID aren't listed by either helper
// (they're not in filtersForRigs at all) — the same behaviour /blueprint/[typeID]
// has always had.
import { flatten, map, uniq } from 'ramda'

import { filtersUsed } from './[typeID]/filters'
import { rigsForFilter } from './[typeID]/modifiers'

// Every rig type id that gives a material bonus to a product in this
// group/category. Pass the *product's* ids, not the blueprint's.
export const rigsForProduct = (groupID: number, categoryID: number): number[] =>
  uniq(flatten(map((filterID) => rigsForFilter(filterID) ?? [], filtersUsed(groupID, categoryID)))).map(Number)

// Whether one fitted rig covers a product — the per-rig test the structure
// bonus resolver needs (a Standup M-Set Ship Manufacturing rig must not
// discount a component build just because it's the strongest rig fitted).
export const rigAppliesToProduct = (rigTypeID: number, groupID: number, categoryID: number): boolean =>
  rigsForProduct(groupID, categoryID).includes(rigTypeID)
