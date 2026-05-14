import { createClient } from '@/utils/supabase/server'
import { categoriesWithFilter, filters, filtersUsed, groupsWithFilter } from './filters'
import { filtersForRigs, rigsForFilter } from './modifiers'
import { flatten, map } from 'ramda'

type BlueprintTypeParams = {
  params: Promise<{
    typeID: string
  }>
}

const BlueprintType = async ({ params }: BlueprintTypeParams) => {
  const { typeID } = await params
  const supabase = await createClient()

  const {
    data: { productTypeID },
  } = await supabase.schema('evesde').from('industryActivityProducts').select().eq('typeID', typeID).limit(1).single()

  const {
    data: { typeName, groupID },
  } = await supabase.schema('evesde').from('invTypes').select().eq('typeID', productTypeID).single()

  const {
    data: { categoryID },
  } = await supabase.schema('evesde').from('invGroups').select().eq('groupID', groupID).single()

  const { data: rigs } = await supabase
    .schema('evesde')
    .from('invTypes')
    .select('typeID, typeName')
    .in('typeID', flatten(map(rigsForFilter, filtersUsed(groupID, categoryID))))
    .order('typeName')

  const sortedRigs = (rigs ?? []).sort(({ typeName: typeNameA }, { typeName: typeNameB }) => {
    let a = typeNameA
    let b = typeNameB
    if (typeNameA.includes('M-Set')) a = 1
    if (typeNameB.includes('M-Set')) b = 1
    if (typeNameA.includes('L-Set')) a = 2
    if (typeNameB.includes('L-Set')) b = 2
    if (typeNameA.includes('XL-Set')) a = 3
    if (typeNameB.includes('XL-Set')) b = 3
    return a - b
  })

  return (
    <>
      <h1>{typeName}</h1>
      <ul>{rigs?.map(({ typeID, typeName }) => <li key={typeID}>{typeName}</li>)}</ul>
    </>
  )
}

export default BlueprintType
