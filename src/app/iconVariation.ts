// Which artwork CCP's image server holds for a type — the pure half of
// TypeIcon, split out so it can be unit-tested (the suite runs on Node's own
// type stripping, which does not parse JSX) and imported by modules that must
// not pull in a component.
// Relative, with the extension: this module is unit-tested, and the test runner
// is plain Node — it resolves no '@/*' path alias (see structureQuery.ts, which
// imports escapeLike the same way).
import { ANCIENT_RELIC_CATEGORY_ID, BLUEPRINT_CATEGORY_ID } from '../utils/sdeCategories.ts'

// Most types have "icon"; blueprints have only "bp"/"bpc" and Ancient Relics
// only "relic". Asking for a variation a type does not have is a **400**, not a
// fallback, so a wrong guess is a broken image rather than a plain one.
export type IconVariation = 'icon' | 'bp' | 'bpc' | 'render' | 'relic'

// The image variation for a blueprint stack: originals and copies have distinct
// artwork, and neither answers to "icon".
export const blueprintIcon = (isCopy: boolean | null | undefined): IconVariation => (isCopy ? 'bpc' : 'bp')

// Which variation a type's SDE CATEGORY implies — the single place that mapping
// lives, so a page can't quietly regrow its own half-copy of it (three had, and
// each knew only about blueprints, which is why every Ancient Relic rendered as
// a broken image).
//
// The image server can be asked directly: GET https://images.evetech.net/types/
// {id} returns the available variations as a JSON array, which is how this rule
// was checked. But that is a network round trip per type on a render path, and
// the answer turns out to be a property of the category — which the SDE mirror
// already gives us for free. Every Ancient Relic sampled, across all three
// tiers and all six Sleeper groups, returned exactly ["relic"]. So this derives
// rather than fetches, and there is no lookup table to keep up to date.
//
// `render` is deliberately not derivable: ships carry both it and "icon", so
// which a page wants is a layout decision (the big hull portrait) only the
// caller can make. It stays an explicit opt-in.
export const iconVariation = (
  categoryID: number | null | undefined,
  isBlueprintCopy?: boolean | null
): IconVariation => {
  if (categoryID === BLUEPRINT_CATEGORY_ID) return blueprintIcon(isBlueprintCopy)
  if (categoryID === ANCIENT_RELIC_CATEGORY_ID) return 'relic'
  return 'icon'
}
