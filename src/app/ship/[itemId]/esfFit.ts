import type { EsiFit } from './esf/fit'

import type { ItemRow } from '../../asset/[locationId]/locationAssets'

// Only these 4 fields of ItemRow are actually needed, so callers that don't
// already have a full ItemRow (e.g. a lean fetch that skips owners/contents)
// don't need to fabricate the rest.
type EsiFitRow = Pick<ItemRow, 'itemId' | 'typeId' | 'flag' | 'quantity'>

// Shapes a ship's fitted-module/cargo/drone rows (the same ItemRow[] fed to
// the module table) into ESI's fitting JSON — the shape `esiFitToEsfFit` in
// ./esf/fit.ts reads. Slot vs. charge disambiguation and cargo/drone-bay
// routing happen there (it has the full type/dogma dataset loaded), so this is
// a plain reshape — no location-flag parsing needed here.
export const toEsiFit = (shipTypeId: number, shipName: string | null, rows: EsiFitRow[]): EsiFit => ({
  name: shipName ?? '',
  description: '',
  ship_type_id: shipTypeId,
  items: rows.map((r) => ({
    item_id: Number(r.itemId),
    type_id: r.typeId,
    flag: r.flag ?? '',
    quantity: Number(r.quantity ?? 1),
  })),
})
