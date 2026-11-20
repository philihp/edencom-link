'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { getSdeType } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../../account/lib/establishedUser'
import { parseQuantity } from '../stock-types/stockTargets'
import { parseBuildBuy, parseSettingsForm, toRow } from './settings'

// Every write is on the cookie session; RLS pins each row to the caller, and
// the user_id filters below are belt and braces.
const requireUser = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/account/login')
  return { supabase, userId: user.id }
}

// A setting changes what every tab computes, so every tab is stale.
const done = () => revalidatePath('/industry/planner', 'layout')

// Save the whole settings form. A bad field refuses the save and says why.
export const saveSettings = async (formData: FormData): Promise<{ ok?: string; error?: string }> => {
  const parsed = parseSettingsForm(Object.fromEntries(formData.entries()))
  if ('error' in parsed) return { error: parsed.error }
  const { supabase, userId } = await requireUser()
  const { error } = await supabase
    .from('planner_settings')
    .upsert(
      { user_id: userId, ...toRow(parsed.settings), updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
  if (error) return { error: error.message }
  done()
  return { ok: 'Saved.' }
}

// ── Manual build or buy ────────────────────────────────────────────────────

// Add a type to the list as "buy" (the sheet's usual reason to list one). The
// SDE lookup refuses an id that names no type; a listed type stays as it is.
export const addBuildBuy = async (typeId: number): Promise<void> => {
  if (!(await getSdeType(Number(typeId)))) return
  const { supabase, userId } = await requireUser()
  await supabase
    .from('planner_build_buy')
    .upsert(
      { user_id: userId, type_id: Number(typeId), choice: 'buy' },
      { onConflict: 'user_id,type_id', ignoreDuplicates: true }
    )
  done()
}

export const setBuildBuy = async (typeId: number, raw: string): Promise<{ ok: boolean }> => {
  const choice = parseBuildBuy(raw)
  if (choice === null) return { ok: false }
  const { supabase, userId } = await requireUser()
  const { error } = await supabase
    .from('planner_build_buy')
    .update({ choice })
    .eq('user_id', userId)
    .eq('type_id', Number(typeId))
  done()
  return { ok: !error }
}

export const removeBuildBuy = async (typeId: number): Promise<void> => {
  const { supabase, userId } = await requireUser()
  await supabase.from('planner_build_buy').delete().eq('user_id', userId).eq('type_id', Number(typeId))
  done()
}

// ── Manual stock ───────────────────────────────────────────────────────────

export const addManualStock = async (typeId: number): Promise<void> => {
  if (!(await getSdeType(Number(typeId)))) return
  const { supabase, userId } = await requireUser()
  await supabase
    .from('planner_manual_stock')
    .upsert({ user_id: userId, type_id: Number(typeId) }, { onConflict: 'user_id,type_id', ignoreDuplicates: true })
  done()
}

export const setManualStock = async (typeId: number, raw: string): Promise<{ ok: boolean }> => {
  const quantity = parseQuantity(raw)
  if (quantity === null) return { ok: false }
  const { supabase, userId } = await requireUser()
  const { error } = await supabase
    .from('planner_manual_stock')
    .update({ quantity, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('type_id', Number(typeId))
  done()
  return { ok: !error }
}

export const removeManualStock = async (typeId: number): Promise<void> => {
  const { supabase, userId } = await requireUser()
  await supabase.from('planner_manual_stock').delete().eq('user_id', userId).eq('type_id', Number(typeId))
  done()
}
