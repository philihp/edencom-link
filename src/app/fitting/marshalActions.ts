'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import {
  type Caller,
  callerForUser,
  deleteMarshalled,
  isFailure,
  marshalFitting,
  type Registration,
  transferFitting,
  unmarshalFitting,
} from '../api/fittings/lib'
import { transferOutcome } from '../api/fittings/marshalOutcome'
import { marshalledRoute, parseMarshalledHandle } from '../api/fittings/marshalledHandle'
import { fittingRoute } from './fit'

// Marshal, unmarshal and transfer from a button (docs/fitting-marshal.md),
// bound by the fitting pages the way actions.ts binds the share dialog. The
// identity proof is the cookie session; everything after it is the same
// service-role Caller and the same lib functions the api_token routes run,
// tagged `source: 'web'` in fitting_write_log. Synchronous, like the routes:
// the player pressed a button and waits one or two ESI round trips.
//
// Ownership: callerForUser lists the registrations of the user the session
// proved, so a registration id named in the call that is not among them is
// refused before anything is asked of CCP. A fit seen through a share is never
// one of these — you cannot marshal someone else's fit out of their client.

const SOURCE = 'web'

type Refusal = { error: string }

const signedInCaller = async (): Promise<Caller | Refusal> => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) return { error: 'Not signed in' }
  const caller = await callerForUser(user.id)
  return isFailure(caller) ? { error: caller.error } : caller
}

const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && 'error' in value && !('registrations' in value)

const own = (caller: Caller, registrationId: string): Registration | Refusal =>
  caller.registrations.find((r) => r.registration_id === registrationId) ?? { error: 'Not your character' }

const parseFittingId = (raw: string): number | Refusal =>
  /^\d+$/.test(raw) ? Number(raw) : { error: 'Not a fitting id' }

const revalidate = (...paths: string[]) => {
  revalidatePath('/fitting')
  paths.forEach((p) => revalidatePath(p))
}

export type MarshalResult = { error?: string; href?: string; contentHash?: string }

/** Marshal: delete the fit from EVE, keep it here. On success, where it now lives. */
export const marshalFittingAction = async (registrationId: string, fittingId: string): Promise<MarshalResult> => {
  const caller = await signedInCaller()
  if (isRefusal(caller)) return caller
  const registration = own(caller, registrationId)
  if (isRefusal(registration)) return registration
  const id = parseFittingId(fittingId)
  if (typeof id !== 'number') return id

  const result = await marshalFitting(caller, registration, id, SOURCE)
  if (isFailure(result)) return { error: result.error }

  revalidate(fittingRoute(registration.character_id, id), marshalledRoute(result.content_hash))
  return { href: marshalledRoute(result.content_hash), contentHash: result.content_hash }
}

export type UnmarshalResult = { error?: string; href?: string; created?: boolean }

/** Unmarshal: save a marshalled fit onto one of the caller's characters. */
export const unmarshalFittingAction = async (contentHash: string, registrationId: string): Promise<UnmarshalResult> => {
  const caller = await signedInCaller()
  if (isRefusal(caller)) return caller
  const registration = own(caller, registrationId)
  if (isRefusal(registration)) return registration
  const hash = parseMarshalledHandle(contentHash)
  if (hash === null) return { error: 'Not a marshalled fitting' }

  const result = await unmarshalFitting(caller, hash, registration, SOURCE)
  if (isFailure(result)) return { error: result.error }

  const href = fittingRoute(result.characterId, result.fitting_id)
  revalidate(href, marshalledRoute(hash))
  return { href, created: result.created }
}

export type TransferResult = {
  error?: string
  // Set on success, and also on the half-done transfer (saved on the target,
  // still on the source), so the player can go look at the copy either way.
  href?: string
  message?: string
}

/** Transfer: save the fit on `to`, then delete it from `from`. */
export const transferFittingAction = async (
  fromRegistrationId: string,
  toRegistrationId: string,
  fittingId: string
): Promise<TransferResult> => {
  const caller = await signedInCaller()
  if (isRefusal(caller)) return caller
  const from = own(caller, fromRegistrationId)
  if (isRefusal(from)) return from
  const to = own(caller, toRegistrationId)
  if (isRefusal(to)) return to
  const id = parseFittingId(fittingId)
  if (typeof id !== 'number') return id

  const outcome = transferOutcome(await transferFitting(caller, from, to, id, SOURCE), from, to)
  revalidate(fittingRoute(from.character_id, id))
  if (outcome.ok) {
    const href = fittingRoute(outcome.characterId, outcome.fittingId)
    revalidatePath(href)
    return { href, message: outcome.message }
  }
  const href =
    outcome.savedCharacterId !== undefined && outcome.savedFittingId !== undefined
      ? fittingRoute(outcome.savedCharacterId, outcome.savedFittingId)
      : undefined
  if (href) revalidatePath(href)
  return { error: outcome.message, ...(href ? { href } : {}) }
}

/**
 * Delete a marshalled fit from the archive. Permanent and ESI-free: a fit that
 * arrived through an ESI delete is still in fitting_write_log, and one copied
 * in from a file is still on that disk, so the archive can be pruned without
 * touching the recovery story.
 */
export const deleteMarshalledAction = async (contentHash: string): Promise<{ error?: string; href?: string }> => {
  const caller = await signedInCaller()
  if (isRefusal(caller)) return caller
  const hash = parseMarshalledHandle(contentHash)
  if (hash === null) return { error: 'Not a marshalled fitting' }

  const deleted = await deleteMarshalled(caller, hash)
  if (isFailure(deleted)) return { error: deleted.error }
  if (!deleted) return { error: 'That fitting is not in the archive any more.' }

  revalidate(marshalledRoute(hash))
  return { href: '/fitting' }
}
