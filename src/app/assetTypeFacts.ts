// The SDE-derived half of an asset row: what a unit occupies, where the type
// sits in the taxonomy, and which image CCP holds for it. Every page that
// builds ItemRows (the asset folder, both ship views) resolves the same facts
// from one getSdeTypes lookup, so they can't drift from each other.
import type { SdeType } from '@/sdeTypes'
import { BLUEPRINT_CATEGORY_ID } from '@/utils/sdeCategories'
import { blueprintIcon, type IconVariation } from './typeIcon'

export type TypeFacts = {
  unitVolume: number | null
  groupName: string | null
  categoryName: string | null
  icon: IconVariation
}

// `type` is undefined for anything the published-type view doesn't cover (an
// unpublished or brand-new type), which leaves the columns blank rather than
// guessing. isBlueprintCopy only matters for blueprint-category rows: CCP's
// image server has no "icon" for those — asking for one is a 400, not a
// fallback — so they point at bp/bpc instead.
export const typeFacts = (type: SdeType | undefined, isBlueprintCopy?: boolean | null): TypeFacts => ({
  unitVolume: type?.volume ?? null,
  groupName: type?.groupName ?? null,
  categoryName: type?.categoryName ?? null,
  icon: type?.categoryID === BLUEPRINT_CATEGORY_ID ? blueprintIcon(isBlueprintCopy) : 'icon',
})
