import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { toEsiFit } from '../esfFit'
import { ShipFitViewDynamic } from '../shipFitViewDynamic'

// Bare view of a single ship's fit — no heading, back link, or cargo grid,
// just the ShipFit component, for the same locationId /asset/[locationId]
// uses. Only the fields toEsiFit needs are fetched.
type ChildRow = {
  item_id: number | string
  type_id: number | string
  location_flag: string | null
  quantity: number | string | null
}

const FitLocationPage = async ({ params }: { params: Promise<{ locationId: string }> }) => {
  const { locationId } = await params
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  const { data: characterSelf } = await supabase
    .from('character_asset')
    .select('type_id, name')
    .eq('item_id', locationId)
    .maybeSingle<{ type_id: number | string; name: string | null }>()
  const { data: corpSelf } = characterSelf
    ? { data: null }
    : await supabase
        .from('corp_asset')
        .select('type_id')
        .eq('item_id', locationId)
        .maybeSingle<{ type_id: number | string }>()
  const self = characterSelf ?? (corpSelf ? { ...corpSelf, name: null } : null)
  if (!self) return null

  const [{ data: characterChildren }, { data: corpChildren }] = await Promise.all([
    supabase.from('character_asset').select('item_id, type_id, location_flag, quantity').eq('location_id', locationId),
    supabase.from('corp_asset').select('item_id, type_id, location_flag, quantity').eq('location_id', locationId),
  ])
  const rows = [...((characterChildren ?? []) as ChildRow[]), ...((corpChildren ?? []) as ChildRow[])].map((r) => ({
    itemId: String(r.item_id),
    typeId: Number(r.type_id),
    flag: r.location_flag,
    quantity: r.quantity,
  }))

  return <ShipFitViewDynamic esiFit={toEsiFit(Number(self.type_id), self.name, rows)} />
}
export default FitLocationPage
