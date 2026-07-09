import type { EsiFit } from '@eveshipfit/react'

import type { ItemRow } from './locationAssets'

// Shapes a ship's fitted-module/cargo/drone rows (the same ItemRow[] fed to
// ShipCargo) into the ESI-fitting-JSON shape @eveshipfit/react's
// useImportEsiFitting() hook expects. Slot vs. charge disambiguation and
// cargo/drone-bay routing happen inside that hook (it already has the full
// type/dogma dataset loaded), so this is a plain reshape — no location-flag
// parsing needed here.
export const toEsiFit = (shipTypeId: number, shipName: string | null, rows: ItemRow[]): EsiFit => ({
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
