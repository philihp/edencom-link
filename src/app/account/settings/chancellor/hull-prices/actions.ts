'use server'

import { revalidatePath } from 'next/cache'

import { HULL_PRICE_GROUP_IDS } from '@/hullPrices'
import { getSdeType } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { isChancellor } from '../chancellor'
import { parseBisk } from './bisk'

// Set or clear the price of one hull. Chancellors only: the write goes through
// the service role, the only role hull_price accepts writes from, so this
// check is the whole of the authorization.
export const saveHullPrice = async (formData: FormData): Promise<{ ok?: string; error?: string }> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return { error: 'Not signed in' }
  if (!(await isChancellor(user.id))) return { error: 'Only chancellors can set hull prices.' }

  // Only a hull the page lists: a supercarrier or a titan.
  const typeId = Number(formData.get('type_id'))
  const type = Number.isInteger(typeId) ? await getSdeType(typeId) : null
  if (!type || !HULL_PRICE_GROUP_IDS.includes(type.groupID)) return { error: 'Not a supercarrier or titan hull.' }

  const price = parseBisk(`${formData.get('price') ?? ''}`)
  if (price === 'invalid') return { error: 'Enter a price in billions of ISK, such as 42 or 41.5.' }

  const service = createServiceClient()
  const { error } =
    price === null
      ? await service.from('hull_price').delete().eq('type_id', typeId)
      : await service
          .from('hull_price')
          .upsert(
            { type_id: typeId, price, updated_at: new Date().toISOString(), updated_by: user.id },
            { onConflict: 'type_id' }
          )
  if (error) return { error: `Could not save: ${error.message}` }

  revalidatePath('/account/settings/chancellor/hull-prices')
  return { ok: price === null ? `${type.name}: price cleared` : `${type.name}: saved` }
}
