'use server'

import { revalidatePath } from 'next/cache'

import { createServiceClient } from '@/utils/supabase/service'
import { createClient } from '@/utils/supabase/server'

import { isChancellor } from './chancellor'

// Both actions are privileged: the caller must already be a Chancellor. Returns
// the caller's id on success, or an error to bubble back to the UI.
const requireChancellor = async (): Promise<{ userId: string } | { error: string }> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return { error: 'Not signed in' }
  if (!(await isChancellor(user.id))) return { error: 'Only chancellors can manage chancellors.' }
  return { userId: user.id }
}

// Promote the account that owns a given EVE character to Chancellor. The target
// is identified by character name (the identity players actually know each other
// by), resolved through registration. The write goes through the service role —
// the only role allowed to set is_chancellor — and upserts so an account with no
// settings row yet is created.
export const grantChancellor = async (formData: FormData): Promise<{ ok?: string; error?: string }> => {
  const gate = await requireChancellor()
  if ('error' in gate) return { error: gate.error }

  const name = `${formData.get('name') ?? ''}`.trim()
  if (!name) return { error: 'Enter a character name.' }

  const service = createServiceClient()

  // ilike with no wildcards is a case-insensitive exact match.
  const { data: regs } = await service.from('registration').select('user_id, name').ilike('name', name)
  const userIds = [...new Set((regs ?? []).map((r) => r.user_id))]
  if (userIds.length === 0) return { error: `No account owns a character named “${name}”.` }
  if (userIds.length > 1) {
    return { error: `“${name}” matches more than one account — use a character only one of them owns.` }
  }

  const { error } = await service
    .from('user_settings')
    .upsert({ user_id: userIds[0], is_chancellor: true, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) return { error: error.message }

  revalidatePath('/account/chancellor')
  return { ok: `${regs?.[0]?.name ?? name}’s account is now a Chancellor.` }
}

// Strip Chancellor from an account (by user id). A Chancellor may step down by
// revoking their own id; the page re-renders without them afterwards.
export const revokeChancellor = async (userId: string): Promise<{ ok?: string; error?: string }> => {
  const gate = await requireChancellor()
  if ('error' in gate) return { error: gate.error }

  const service = createServiceClient()
  const { error } = await service
    .from('user_settings')
    .update({ is_chancellor: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
  if (error) return { error: error.message }

  revalidatePath('/account/chancellor')
  return { ok: 'Chancellor revoked.' }
}
