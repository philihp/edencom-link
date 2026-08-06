// Walking one place in the hangar and turning it into appraisal lines:
// everything nested under a target id, folded (in ./assetLines.ts) into the
// `(name, quantity)` pairs innomin.at prices in a single request.
//
// Shared by the asset viewer's route (POST /api/appraisal) and the MCP
// appraise_assets tool, which differ only in how they authenticate and how much
// of the answer they itemize. The walk itself must not diverge between them:
// what counts as "inside" a container, and what is deliberately left unpriced,
// is the part that would be quietly wrong if it were written twice.
//
// Every query runs on the caller's own client — cookie session or bearer token,
// never the service role. The *_asset_subtree_items() functions are SECURITY
// INVOKER and rely on RLS to scope their walk, so a service-role caller would
// happily walk (and price) another user's items.
import type { SupabaseClient } from '@supabase/supabase-js'
import { forEach } from 'ramda'

import { getSdeTypes } from '@/sdeTypes'

import { toAppraisalLines, type AssetLines } from './assetLines'

type SubtreeRow = { type_id: number | string; quantity: number | string }
type SelfRow = { type_id: number | string; quantity: number | string | null; is_singleton: boolean | null }

// Everything under one target id, as appraisal lines.
//
// The target is either one of the caller's own items (ship, container or plain
// stack) or a bare place id — a station, structure or solar system. RLS decides
// what's visible, so an id the caller doesn't own simply reads as a location
// whose subtree comes back empty.
export const collectAssetLines = (supabase: SupabaseClient, target: string): Promise<AssetLines> =>
  collectAssetLinesForTargets(supabase, [target])

// The same, over several targets at once — what the asset table's checkbox
// selection appraises. Still four queries however many rows are selected: the
// array-taking *_asset_subtree_items() overloads descend every target in one
// walk, and the two self lookups are `in` filters rather than a lookup apiece.
// Pricing has to stay a single upstream request (the provider budget is 200 an
// hour, deployment-wide), so the fan-out has to collapse on our side too.
//
// Targets are deliberately not required to be disjoint: selecting a container
// and something inside it prices each item exactly once (the walk folds an item
// reached twice, and drops any item that is itself a target, since every
// resolved target gets its own line here).
export const collectAssetLinesForTargets = async (supabase: SupabaseClient, targets: string[]): Promise<AssetLines> => {
  // An item lives in exactly one of the two hangar tables, so unioning both
  // sides can't double-count — that holds for the self rows and the walks alike.
  const [{ data: characterSelves }, { data: corpSelves }, { data: characterRows }, { data: corpRows }] =
    await Promise.all([
      supabase.from('character_asset').select('type_id, quantity, is_singleton').in('item_id', targets),
      supabase.from('corp_asset').select('type_id, quantity, is_singleton').in('item_id', targets),
      supabase.rpc('character_asset_subtree_items', { parents: targets }),
      supabase.rpc('corp_asset_subtree_items', { parents: targets }),
    ])

  const quantities = new Map<number, number>()
  const add = (typeId: number, quantity: number) => quantities.set(typeId, (quantities.get(typeId) ?? 0) + quantity)
  forEach(
    (r: SubtreeRow) => add(Number(r.type_id), Number(r.quantity)),
    [...((characterRows ?? []) as SubtreeRow[]), ...((corpRows ?? []) as SubtreeRow[])]
  )
  // Those functions return strictly the contents, so an item target still owes
  // its own line — the hull of a ship, the container itself, a plain stack that
  // holds nothing. A bare location has nothing to add, and simply doesn't
  // resolve to a self row.
  forEach(
    (self: SelfRow) => add(Number(self.type_id), self.is_singleton ? 1 : Number(self.quantity ?? 1)),
    [...((characterSelves ?? []) as SelfRow[]), ...((corpSelves ?? []) as SelfRow[])]
  )

  return toAppraisalLines(quantities, await getSdeTypes([...quantities.keys()]))
}
