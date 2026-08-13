// Folding a walked hangar subtree into the lines an appraisal sends upstream.
//
// The pure half of the appraisal seam shared by the asset viewer's route
// (POST /api/appraisal) and the MCP appraise_assets tool; ./collectAssetLines.ts
// does the querying and hands the tally here. Like blueprintQuery.ts and
// structureQuery.ts this module pulls in no I/O — only ramda — so what gets
// priced, merged and deliberately left out is unit-testable without a Supabase
// client (see test/assetLines.test.ts).
import { forEach } from 'ramda'

// Relative + .ts, like rigs.ts and structureQuery.ts: `pnpm test` runs Node's
// stripped-types loader, which resolves no path aliases.
import { BLUEPRINT_CATEGORY_ID } from '../../../utils/sdeCategories.ts'

// One appraisal is always exactly one upstream request — the request budget is
// deployment-wide, so looping per item is never an option. A hangar with more
// distinct types than a single batch can carry is therefore refused outright
// rather than truncated: a partial total still looks authoritative, and being
// quietly wrong about how much someone's stuff is worth is worse than saying no.
export const MAX_LINES = 500

// What the innomin.at client takes. Declared structurally rather than imported
// from src/innominate.ts, which reaches for the queue and a Supabase client.
export type AppraisalLine = { name: string; quantity: number }

// Only the fields the fold cares about, so a caller can pass an SDE type map
// straight in without this module importing the loaders.
export type TypeInfo = { name?: string | null; categoryID?: number | null }

export type AssetLines = {
  // What to send upstream, one entry per distinct item name.
  lines: AppraisalLine[]
  // Blueprint types dropped rather than priced (see below), by count.
  skippedBlueprints: number
  // Types the SDE couldn't name, as `#<id>` — they can't be priced by name.
  unnamed: string[]
}

// Fold a type→quantity tally into appraisal lines.
//
// Two things get left out, both reported rather than silently folded into the
// total: asset rows carry no way to tell a worthless copy from an original, so
// pricing blueprints would be wrong more often than right; and a type the SDE
// can't name can't be priced at all, since the API is keyed on item name.
//
// Distinct type ids sharing one name are rare but real in the SDE; merging here
// keeps them from being sent as two lines and counted twice.
export const toAppraisalLines = (
  quantities: Map<number, number>,
  types: Record<number, TypeInfo | undefined>
): AssetLines => {
  const typeIds = [...quantities.keys()]
  const priceable = typeIds.filter((id) => types[id]?.categoryID !== BLUEPRINT_CATEGORY_ID)

  const lines = new Map<string, AppraisalLine>()
  forEach((id: number) => {
    const name = types[id]?.name
    if (!name) return
    const existing = lines.get(name)
    lines.set(name, { name, quantity: (existing?.quantity ?? 0) + (quantities.get(id) ?? 1) })
  }, priceable)

  return {
    lines: [...lines.values()],
    skippedBlueprints: typeIds.length - priceable.length,
    unnamed: priceable.filter((id) => !types[id]?.name).map((id) => `#${id}`),
  }
}
