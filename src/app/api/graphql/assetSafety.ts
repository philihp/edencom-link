// Asset safety for the `restock` list: stock the game holds in a sort of
// limbo, so supply planning does not count it as on hand. Pure, like
// restock.ts, so test/graphqlRestock.test.ts runs it under the node test
// runner.
//
// Two kinds of stock are in limbo:
//
//   - Stock that asset safety moved and that nobody delivered yet. ESI gives
//     it the `AssetSafety` flag, and the items inside an Asset Safety Wrap
//     sit below that flag. This is DETECTION: the walk in assetWithin.ts
//     follows the parent chain, so the flag also catches what is in a wrap.
//   - Stock delivered to an NPC station in an asset-safety destination
//     system. After delivery the flag is gone and the hangar is a normal
//     hangar, so nothing in ESI tells it apart. A CATALOG of systems is the
//     only signal. These systems are far from where the stock is used, and
//     moving it out is a logistics job of its own.
//
// To add a system, add one entry below. The id is the SDE solar system id
// (MCP `list_planets` with `system` shows it). A system id also covers every
// NPC station and structure in that system (see assetWithin.ts).
import type { WithinFilters } from './assetWithin.ts'

export const ASSET_SAFETY_FLAG = 'AssetSafety'

export type AssetSafetySystem = { id: number; name: string; region: string }

export const ASSET_SAFETY_SYSTEMS: readonly AssetSafetySystem[] = [
  // Lowsec destinations where the owner's asset safety lands.
  { id: 30003935, name: 'Irmalin', region: 'Khanid' },
  { id: 30003897, name: 'Gehi', region: 'Khanid' },
  { id: 30000019, name: 'Podion', region: 'Derelik' },
  { id: 30000044, name: 'Faspera', region: 'Derelik' },
]

// The two reads that find the limbo stacks of the target types. They are
// separate because the walk ANDs a location filter with a flag filter.
export const limboFilters = (typeIds: readonly number[]): WithinFilters[] => [
  { typeIds, locationIds: ASSET_SAFETY_SYSTEMS.map(({ id }) => String(id)), include: null, exclude: null },
  { typeIds, locationIds: null, include: [ASSET_SAFETY_FLAG], exclude: null },
]
