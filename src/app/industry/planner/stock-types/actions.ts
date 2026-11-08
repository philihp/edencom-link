'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { getSdeType, searchSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../../account/lib/establishedUser'
import { parseQuantity, QUANTITY_COLUMNS, type QuantityColumn } from './stockTargets'

const PATH = '/industry/planner/stock-types'

// Autocomplete for the "add a type" box, from the SDE mirror; no ESI call.
export const searchTypes = async (query: string): Promise<[typeID: number, name: string][]> =>
  (await searchSdeTypes(query, 8)).map((t) => [t.typeID, t.name])

const requireUser = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/account/login')
  return { supabase, userId: user.id }
}

const isColumn = (c: string): c is QuantityColumn => (QUANTITY_COLUMNS as readonly string[]).includes(c)

// Add a line for a type, with every quantity at zero. The SDE lookup refuses
// an id that names no type; an already-listed type is left as it is.
export const addTarget = async (typeId: number): Promise<void> => {
  if (!(await getSdeType(Number(typeId)))) return
  const { supabase, userId } = await requireUser()
  await supabase
    .from('planner_stock_target')
    .upsert({ user_id: userId, type_id: Number(typeId) }, { onConflict: 'user_id,type_id', ignoreDuplicates: true })
  revalidatePath(PATH)
}

// Set one quantity of one line. Refuses a value that is not a whole number at
// or above zero, and a column that is not one of the three.
export const setQuantity = async (typeId: number, column: string, raw: string): Promise<{ ok: boolean }> => {
  const quantity = parseQuantity(raw)
  if (quantity === null || !isColumn(column)) return { ok: false }
  const { supabase, userId } = await requireUser()
  const { error } = await supabase
    .from('planner_stock_target')
    .update({ [column]: quantity, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('type_id', Number(typeId))
  revalidatePath(PATH)
  return { ok: !error }
}

// Remove a line. RLS already scopes the delete to the caller's rows; the
// user_id filter is belt and braces.
export const removeTarget = async (typeId: number): Promise<void> => {
  const { supabase, userId } = await requireUser()
  await supabase.from('planner_stock_target').delete().eq('user_id', userId).eq('type_id', Number(typeId))
  revalidatePath(PATH)
}
