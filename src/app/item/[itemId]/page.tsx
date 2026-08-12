import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { FIT_UI_FLAG, hasFlag } from '@/flags'
import { getSdeType } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import { toEsiFit } from '../../ship/[itemId]/esfFit'
import { SHIP_CATEGORY_ID, fittingOrder } from '../../ship/[itemId]/shipRows'
import { FitDebugDynamic } from './fitDebugDynamic'

// Stage 0 of docs/custom-fit-ui.md: the same ship /ship/[itemId] renders,
// fed through our own fitting stack instead of @eveshipfit/react, rendering
// no fitting UI at all — just what the stack produced, to be read against the
// embed on /ship/[itemId].
//
// Dark-launched: nothing links here, and the `fit-ui` flag gates it, so
// obscurity isn't the only gate. Access is otherwise exactly /ship's
// signed-in path — the same RLS-scoped queries, so this route can't see a
// ship its owner couldn't. The share-token path is deliberately not mirrored:
// an unfinished debug page has no business being anonymously reachable.

type ShipRow = {
  item_id: number | string
  type_id: number | string
  name: string | null
  registration_id?: string
  corporation_id?: number | string
}

// A row inside the ship: a fitted module, its ammunition, a drone, or cargo.
type FittedRow = {
  item_id: number | string
  type_id: number | string
  location_flag: string | null
  quantity: number | string | null
}

const ItemFitPage = async ({ params }: { params: Promise<{ itemId: string }> }) => {
  const { itemId } = await params

  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) redirect('/')
  // A visitor without the flag gets the same answer as a visitor to a route
  // that doesn't exist.
  if (!(await hasFlag(auth.user.id, FIT_UI_FLAG))) notFound()

  // Both hangars probed at once, character wins — the same shape /ship uses,
  // minus everything this page doesn't render (owner, location, breadcrumb).
  const [{ data: characterSelf }, { data: corpSelf }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, registration_id, type_id, name')
      .eq('item_id', itemId)
      .maybeSingle<ShipRow>(),
    supabase.from('corp_asset').select('item_id, corporation_id, type_id').eq('item_id', itemId).maybeSingle<ShipRow>(),
  ])
  const self = characterSelf ?? corpSelf
  if (!self) notFound()

  const selfType = await getSdeType(Number(self.type_id))
  if (selfType?.categoryID !== SHIP_CATEGORY_ID) notFound()

  const [{ data: characterChildren }, { data: corpChildren }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, type_id, location_flag, quantity')
      .eq('location_id', itemId)
      .returns<FittedRow[]>(),
    supabase
      .from('corp_asset')
      .select('item_id, type_id, location_flag, quantity')
      .eq('location_id', itemId)
      .returns<FittedRow[]>(),
  ])
  const children = [...(characterChildren ?? []), ...(corpChildren ?? [])]

  // The same rows /ship feeds its viewer, in the same fitting-window order, so
  // the two pages are demonstrably looking at one fit. Only the four fields
  // toEsiFit reads are built — the rest of an ItemRow describes a table this
  // page doesn't render.
  const rows = fittingOrder(
    children.map((child) => ({
      itemId: String(child.item_id),
      typeId: Number(child.type_id),
      flag: child.location_flag,
      quantity: child.quantity,
    }))
  )

  const typeName = selfType?.name ?? `#${self.type_id}`

  return (
    <>
      <h1>{self.name && self.name !== typeName ? `${self.name} (${typeName})` : typeName}</h1>
      <p>
        Fitting-stack spike (docs/custom-fit-ui.md, stage 0). No fitting UI here — this page exists to prove the
        non-visual half works: our protobuf decoder over <Link href="/esf/types.pb2">/esf/</Link>, the dogma
        engine&apos;s data callbacks, the all-skills-V baseline, and the ESI flag → slot mapping.
      </p>
      <FitDebugDynamic esiFit={toEsiFit(Number(self.type_id), self.name ?? null, rows)} itemId={itemId} />
    </>
  )
}

export default ItemFitPage
