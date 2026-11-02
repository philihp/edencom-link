import { Name } from '../../names'
import { fetchTypeNames } from '../../typeNames'
import { fetchType, resolveProductTypeID } from '../api'
import { rigsForProduct } from '../rigs'

// The rig page for a blueprint TYPE: which Upwell rigs bonus what it builds.
// Rendered by /blueprint/[id] when the id is a type id (page.tsx).
export const BlueprintTypePage = async ({ typeId }: { typeId: number }) => {
  // Resolve the item the blueprint manufactures, then that product's
  // group/category, which determine the applicable rigs.
  const blueprint = await fetchType(typeId)
  const productTypeID = blueprint?.name != null ? await resolveProductTypeID(blueprint.name) : null
  const product = productTypeID != null ? await fetchType(productTypeID) : null

  if (blueprint?.name == null) {
    return <h1>#{typeId}</h1>
  }

  if (product?.groupID == null) {
    return (
      <>
        <h1>
          <Name name={blueprint.name} />
        </h1>
        <p>Couldn&apos;t resolve the item this blueprint builds.</p>
      </>
    )
  }

  const categoryID = product.categoryID ?? -1
  const rigTypeIDs = rigsForProduct(product.groupID, categoryID)

  const rigNames = await fetchTypeNames(rigTypeIDs)
  const sortedRigs = rigTypeIDs
    .map((id): [number, string | null] => [id, rigNames[id] ?? null])
    .sort(([, a], [, b]) => (a ?? '').localeCompare(b ?? ''))

  return (
    <>
      <h1>
        <Name name={product.name ?? blueprint.name} />
      </h1>
      {sortedRigs.length === 0 ? (
        <p>No Upwell rigs give this blueprint a bonus.</p>
      ) : (
        <ul>
          {sortedRigs.map(([id, name]) => (
            <li key={id}>
              <Name name={name} id={id} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
