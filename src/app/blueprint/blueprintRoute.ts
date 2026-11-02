// One segment, two kinds of id (docs/item-pages.md, "One route, two ids"):
// /blueprint/[id] is the rig page for a blueprint TYPE and the item page for
// one blueprint the caller holds. They are told apart by magnitude. The SDE's
// type ids are six digits today; a player item's id is thirteen. Nothing in
// between is either, so the floor sits where neither will ever reach. Pure,
// tested.

// The smallest id read as an item. 10⁹: three orders past the largest type
// id CCP has minted, three short of the smallest player item id.
export const ITEM_ID_FLOOR = 1_000_000_000

export type BlueprintRoute = { kind: 'type'; typeId: number } | { kind: 'item'; itemId: number } | { kind: 'invalid' }

export const classifyBlueprintId = (raw: string): BlueprintRoute => {
  if (!/^\d+$/.test(raw)) return { kind: 'invalid' }
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) return { kind: 'invalid' }
  return id >= ITEM_ID_FLOOR ? { kind: 'item', itemId: id } : { kind: 'type', typeId: id }
}
