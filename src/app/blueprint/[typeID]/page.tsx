import { Name } from '../../names'
import { fetchTypeNames } from '../../typeNames'
import { fetchType, resolveProductTypeID } from '../api'
import { rigsForProduct } from '../rigs'

type BlueprintTypeParams = {
  params: Promise<{ typeID: string }>
}

const BlueprintType = async ({ params }: BlueprintTypeParams) => {
  const { typeID } = await params

  // The route param is the blueprint's typeID. Resolve the item it manufactures,
  // then that product's group/category, which determine the applicable rigs.
  const blueprint = await fetchType(Number(typeID))
  const productTypeID = blueprint?.name != null ? await resolveProductTypeID(blueprint.name) : null
  const product = productTypeID != null ? await fetchType(productTypeID) : null

  if (blueprint?.name == null) {
    return <h1>#{typeID}</h1>
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

export default BlueprintType
