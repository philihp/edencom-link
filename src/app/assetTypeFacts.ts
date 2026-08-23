// The SDE-derived half of an asset row: what a unit occupies, where the type
// sits in the taxonomy, and which image CCP holds for it. Every page that
// builds ItemRows (the asset folder, both ship views) resolves the same facts
// from one getSdeTypes lookup, so they can't drift from each other.
import type { SdeType } from '@/sdeTypes'
import { iconVariation, type IconVariation } from './typeIcon'

export type TypeFacts = {
  unitVolume: number | null
  groupName: string | null
  categoryName: string | null
  icon: IconVariation
}

// `type` is undefined for anything the published-type view doesn't cover (an
// unpublished or brand-new type), which leaves the columns blank rather than
// guessing. The icon comes from the category (iconVariation): blueprints and
// Ancient Relics have no "icon" on CCP's image server — asking for one is a
// 400, not a fallback — so they point at bp/bpc and relic instead.
// isBlueprintCopy only matters for the blueprint case.
export const typeFacts = (type: SdeType | undefined, isBlueprintCopy?: boolean | null): TypeFacts => ({
  unitVolume: type?.volume ?? null,
  groupName: type?.groupName ?? null,
  categoryName: type?.categoryName ?? null,
  icon: iconVariation(type?.categoryID, isBlueprintCopy),
})
