// Shaping seam for the module_variants MCP tool: a type's variation family
// (the sde_type_variants RPC, via src/sdeTypes.ts getSdeTypeVariants) turned
// into rows an agent hunting for upgrades can act on.
//
// Like planetQuery.ts this module pulls in no I/O, so it is unit-testable
// without a Supabase client (test/variantQuery.test.ts). Row types are
// declared structurally rather than imported from src/sdeTypes so the seam
// stays free of the loader's client import.

export type VariantLike = {
  typeID: number
  name: string
  metaGroupID: number | null
  metaGroupName: string | null
  metaLevel: number
  published: boolean
  isParent: boolean
}

// The Abyssal meta group: a mutated module's attributes are rolled per item,
// so its type says little about what any one of them does.
export const ABYSSAL_META_GROUP_ID = 15

// An item reference as typed: a bare positive integer is a type id, anything
// else a name to search.
export type TypeRef = { kind: 'id'; typeID: number } | { kind: 'name'; query: string }

export const parseTypeRef = (raw: string): TypeRef => {
  const trimmed = raw.trim()
  return /^\d+$/.test(trimmed) && Number(trimmed) > 0
    ? { kind: 'id', typeID: Number(trimmed) }
    : { kind: 'name', query: trimmed }
}

// The tier a variant belongs to. The SDE stamps no meta group on a plain Tech
// I type, so a missing one reads as Tech I; an id the mirror has no name for
// still says which group it is.
export const tierName = (v: Pick<VariantLike, 'metaGroupID' | 'metaGroupName'>): string =>
  v.metaGroupName ?? (v.metaGroupID == null ? 'Tech I' : `Meta group ${v.metaGroupID}`)

export type VariantRow = {
  type_id: string
  name: string
  meta_level: number
  tier: string
  this?: true
  higher_meta?: true
  blueprint?: string
  published?: false
}

export type FormattedFamily = {
  root: string | null
  rows: VariantRow[]
  higherMeta: number
  hiddenUnpublished: number
  hasAbyssal: boolean
}

// The family as rows, in the order the RPC returns it (lowest meta level
// first). The asked-about type is marked `this`; every variant whose meta
// level is above it is marked `higher_meta` — the upgrade candidates.
// Unpublished variants cannot be bought or built, so they are left out unless
// asked for (the asked-about type itself always stays). `blueprintOf` names the
// blueprint that builds a variant, when one does.
export const formatFamily = (
  family: readonly VariantLike[],
  askedTypeID: number,
  includeUnpublished: boolean,
  blueprintOf: (typeID: number) => string | undefined
): FormattedFamily => {
  const asked = family.find((v) => v.typeID === askedTypeID)
  const shown = family.filter((v) => includeUnpublished || v.published || v.typeID === askedTypeID)
  const isHigher = (v: VariantLike) => asked != null && v.metaLevel > asked.metaLevel
  const rows = shown.map((v): VariantRow => {
    const blueprint = blueprintOf(v.typeID)
    return {
      type_id: String(v.typeID),
      name: v.name,
      meta_level: v.metaLevel,
      tier: tierName(v),
      ...(v.typeID === askedTypeID && { this: true as const }),
      ...(isHigher(v) && { higher_meta: true as const }),
      ...(blueprint != null && { blueprint }),
      ...(!v.published && { published: false as const }),
    }
  })
  return {
    root: family.find((v) => v.isParent)?.name ?? null,
    rows,
    higherMeta: shown.filter(isHigher).length,
    hiddenUnpublished: family.length - shown.length,
    hasAbyssal: shown.some((v) => v.metaGroupID === ABYSSAL_META_GROUP_ID),
  }
}
