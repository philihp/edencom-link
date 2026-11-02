// Where clicking an asset row goes (docs/item-pages.md, "The link rule"): the
// one rule behind the asset folder and both ship views, so the three tables
// cannot drift. Pure, so it is unit-tested; relative import with the extension
// because the test runner is plain Node with no '@/*' alias.
//
// Only an item that is one of a kind gets a page of its own. An assembled
// hull is a ship (/ship); a packaged hull is a stack of hulls and gets none,
// however many are in it. A blueprint is always a singleton in ESI, original
// or copy, so the category alone would do — is_singleton is tested anyway, so
// a packaged blueprint stack, should CCP ever ship one, falls through to the
// stack rule. Anything holding items is a container (/asset). A plain stack
// goes nowhere.
import { BLUEPRINT_CATEGORY_ID, SHIP_CATEGORY_ID } from '../../utils/sdeCategories.ts'

export type ItemHrefInput = {
  itemId: number | string
  // The SDE category of the row's type; null for a type the published-type
  // view does not cover, which can then only be a container.
  categoryId: number | null | undefined
  isSingleton: boolean | null | undefined
  // How many items the row holds, counted across its whole subtree.
  contents: number
}

export const itemHref = ({ itemId, categoryId, isSingleton, contents }: ItemHrefInput): string | null => {
  if (isSingleton) {
    if (categoryId === SHIP_CATEGORY_ID) return `/ship/${itemId}`
    if (categoryId === BLUEPRINT_CATEGORY_ID) return `/blueprint/${itemId}`
  }
  return contents > 0 ? `/asset/${itemId}` : null
}
