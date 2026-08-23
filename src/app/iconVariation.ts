// Which artwork CCP's image server holds for a type, and how to choose among
// what it has. The pure half of TypeIcon — split out so it can be unit-tested
// (the suite runs on Node's own type stripping, which does not parse JSX) and
// imported by modules that must not pull in a component.
//
// Relative import with the extension: this module is unit-tested and the runner
// is plain Node, which resolves no '@/*' path alias.
import { ANCIENT_RELIC_CATEGORY_ID, BLUEPRINT_CATEGORY_ID } from '../utils/sdeCategories.ts'

// Most types have "icon"; blueprints have only "bp"/"bpc" and Ancient Relics
// only "relic". Asking for a variation a type does not have is a **400**, not a
// fallback, so a wrong guess is a broken image rather than a plain one.
export type IconVariation = 'icon' | 'bp' | 'bpc' | 'render' | 'relic'

const KNOWN: readonly string[] = ['icon', 'bp', 'bpc', 'render', 'relic']

export const isIconVariation = (value: unknown): value is IconVariation =>
  typeof value === 'string' && KNOWN.includes(value)

// CCP answers GET https://images.evetech.net/types/{id} with a JSON array of
// the variations it holds. Parsed defensively — it's a third party, and an
// unexpected shape should narrow the choice rather than throw inside a render.
export const parseVariations = (payload: unknown): IconVariation[] =>
  Array.isArray(payload) ? payload.filter(isIconVariation) : []

// The house preference, in priority order. "icon" leads because it is the right
// answer whenever a type has a choice; "render" trails because a hull portrait
// is a layout decision, never something to fall into by default. Blueprints and
// relics have no "icon" at all, so they simply fall through to their own entry.
export const DEFAULT_PREFERENCE: readonly IconVariation[] = ['icon', 'bp', 'relic', 'bpc', 'render']

// Same list with the two blueprint entries swapped, for a row known to be a
// copy: a BPC's available set is ["bpc","bp"], so without this it would show
// the original's artwork.
export const COPY_PREFERENCE: readonly IconVariation[] = ['icon', 'bpc', 'bp', 'relic', 'render']

// A caller's hint, widened into a full priority list. The hint leads and the
// house order follows, so `prefer="render"` still lands somewhere sensible for
// a type that has no render rather than resolving to nothing.
export const preferenceFor = (
  hint?: IconVariation | readonly IconVariation[] | null,
  isBlueprintCopy?: boolean | null
): IconVariation[] => {
  const lead = hint == null ? [] : Array.isArray(hint) ? [...hint] : [hint as IconVariation]
  const house = isBlueprintCopy ? COPY_PREFERENCE : DEFAULT_PREFERENCE
  return [...new Set([...lead, ...house])]
}

// The first preference the type actually has. Falls back to whatever it does
// have (the list is never empty in practice, but a type CCP holds nothing for
// resolves to null rather than a guaranteed 400).
export const pickVariation = (
  available: readonly IconVariation[],
  preference: readonly IconVariation[]
): IconVariation | null => preference.find((v) => available.includes(v)) ?? available[0] ?? null

// The opening guess, before anything has been asked of the image server — what
// the type's SDE CATEGORY implies. Used for the first paint (and for the server
// render, which cannot fetch), with the component correcting itself from the
// real list if the guess turns out to 400.
//
// The category is a good enough guess to make that correction rare: every
// Ancient Relic sampled, across all three tiers and all six Sleeper groups,
// returned exactly ["relic"], and blueprints are uniformly ["bpc","bp"]. It is
// only a guess, though — it is CCP's data, not a documented contract, which is
// why the component verifies rather than trusts.
export const iconVariation = (
  categoryID: number | null | undefined,
  isBlueprintCopy?: boolean | null
): IconVariation => {
  if (categoryID === BLUEPRINT_CATEGORY_ID) return isBlueprintCopy ? 'bpc' : 'bp'
  if (categoryID === ANCIENT_RELIC_CATEGORY_ID) return 'relic'
  return 'icon'
}

// The image variation for a blueprint stack: originals and copies have distinct
// artwork, and neither answers to "icon".
export const blueprintIcon = (isCopy: boolean | null | undefined): IconVariation => (isCopy ? 'bpc' : 'bp')

export const variationsUrl = (typeID: number) => `https://images.evetech.net/types/${typeID}`

// CCP's image server serves fixed power-of-two sizes; ask for the one that
// still has pixels to spare at 2× the rendered size.
export const fetchSize = (size: number) => (size <= 32 ? 64 : size <= 64 ? 128 : size <= 128 ? 256 : 512)

export const iconUrl = (typeID: number, variation: IconVariation, size: number) =>
  `https://images.evetech.net/types/${typeID}/${variation}?size=${fetchSize(size)}`
