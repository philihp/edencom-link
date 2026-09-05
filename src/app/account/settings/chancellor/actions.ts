'use server'

import { randomBytes } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { pluck, uniq } from 'ramda'

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

// Accounts are named by one of their EVE character names — the identity players
// know each other by — resolved through registration with the service role,
// since a Chancellor's own RLS view of registration only covers their own
// characters. A name two accounts both own can't identify either.
const resolveAccountByCharacter = async (
  name: string
): Promise<{ userId: string; name: string } | { error: string }> => {
  if (!name) return { error: 'Enter a character name.' }

  const service = createServiceClient()
  // ilike with no wildcards is a case-insensitive exact match.
  const { data: regs } = await service.from('registration').select('user_id, name').ilike('name', name)
  const userIds = uniq(pluck('user_id', regs ?? []) as string[])
  if (userIds.length === 0) return { error: `No account owns a character named “${name}”.` }
  if (userIds.length > 1) {
    return { error: `“${name}” matches more than one account — use a character only one of them owns.` }
  }
  return { userId: userIds[0], name: regs?.[0]?.name ?? name }
}

// Promote the account that owns a given EVE character to Chancellor by flagging
// the invite_code row that account holds — `redeemed_by` is unique per account,
// so that row identifies it. Registration is open now
// (docs/open-registration.md), so an account may hold no row at all; conferral
// then mints one, carrying the flag and crediting no referrer. The write goes
// through the service role, the only role allowed to set is_chancellor.
export const grantChancellor = async (formData: FormData): Promise<{ ok?: string; error?: string }> => {
  const gate = await requireChancellor()
  if ('error' in gate) return { error: gate.error }

  const target = await resolveAccountByCharacter(`${formData.get('name') ?? ''}`.trim())
  if ('error' in target) return { error: target.error }

  const service = createServiceClient()

  const { data: redeemed } = await service
    .from('invite_code')
    .select('id')
    .eq('redeemed_by', target.userId)
    .limit(1)
    .maybeSingle()

  const { error } = redeemed
    ? await service.from('invite_code').update({ is_chancellor: true }).eq('id', redeemed.id)
    : await service.from('invite_code').insert({
        code: randomBytes(8).toString('hex'),
        redeemed_by: target.userId,
        redeemed_at: new Date().toISOString(),
        is_chancellor: true,
      })
  if (error) return { error: error.message }

  revalidatePath('/account/settings/chancellor')
  return { ok: `${target.name}’s account is now a Chancellor.` }
}

// Strip Chancellor from an account (by user id) by clearing the flag on the code
// it redeemed. A Chancellor may step down by revoking their own id; the page
// re-renders without them afterwards.
export const revokeChancellor = async (userId: string): Promise<{ ok?: string; error?: string }> => {
  const gate = await requireChancellor()
  if ('error' in gate) return { error: gate.error }

  const service = createServiceClient()
  const { error } = await service.from('invite_code').update({ is_chancellor: false }).eq('redeemed_by', userId)
  if (error) return { error: error.message }

  revalidatePath('/account/settings/chancellor')
  return { ok: 'Chancellor revoked.' }
}
