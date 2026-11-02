import { notFound } from 'next/navigation'
import { match } from 'ts-pattern'

import { classifyBlueprintId } from '../blueprintRoute'
import { BlueprintItemPage } from '../item/itemPage'
import { BlueprintTypePage } from './typePage'

// One segment, two kinds of page (docs/item-pages.md, "One route, two ids"):
// a blueprint TYPE's rig page, as this route has always been, or one
// blueprint the caller holds — an original or a copy — with its run history,
// its totals and its memory. A type id and a player item id live orders of
// magnitude apart, so the number alone says which.
export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ id: string }>
}

const BlueprintPage = async ({ params }: PageProps) => {
  const { id } = await params
  return match(classifyBlueprintId(id))
    .with({ kind: 'type' }, ({ typeId }) => <BlueprintTypePage typeId={typeId} />)
    .with({ kind: 'item' }, ({ itemId }) => <BlueprintItemPage itemId={itemId} />)
    .with({ kind: 'invalid' }, () => notFound())
    .exhaustive()
}

export default BlueprintPage
