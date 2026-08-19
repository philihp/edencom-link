// Shared plumbing for /api/fittings — the archive API the macOS FUSE client
// mounts (docs/fitting-fuse.md).
//
// Two things live here that the three route files all need: authenticating a
// request that carries no Supabase session, and the write path to ESI.
//
// Everything ESI-mutating in this app is in this one file. The rule everywhere
// else is UI → DB → extract job → ESI, with the app only ever reading CCP's
// copy of the universe. Archiving a fitting is the exception, and it is
// deliberately *synchronous* rather than queued: the caller is a filesystem, so
// `rm` has to have actually deleted the fit by the time it returns, or the next
// `ls` shows a file that isn't there any more.
import { NextResponse } from 'next/server'

import { createFitting, deleteFitting, fittings as fetchFittings } from '@/esi'
import { type ArchiveFitting, contentHash, FITTING_SLOTS, type FittingBody, normalizeItems } from '@/fittingArchive'
import { createServiceClient } from '@/utils/supabase/service'

export const READ_SCOPE = 'esi-fittings.read_fittings.v1'
export const WRITE_SCOPE = 'esi-fittings.write_fittings.v1'

type ServiceClient = ReturnType<typeof createServiceClient>

export type Registration = {
  registration_id: string
  /** The EVE numeric character id, as a string (it's a bigint). */
  character_id: string
  name: string | null
}

export type Caller = {
  supabase: ServiceClient
  userId: string
  registrations: Registration[]
}

export type Failure = { status: number; error: string }

const failure = (status: number, error: string): Failure => ({ status, error })

/** A Failure as the JSON body every route in this tree answers errors with. */
export const errorResponse = (f: Failure): NextResponse => NextResponse.json({ error: f.error }, { status: f.status })

// The api_token, from an Authorization: Bearer header or a ?token= query param.
// The header is what the FUSE client sends; the query param matches how the
// Sheets CSV endpoints are called and keeps a fitting listing curl-able the
// same way (src/utils/apiToken.ts).
const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match) return match[1].trim()
  return new URL(request.url).searchParams.get('token')?.trim() || undefined
}

/**
 * Resolve the caller's api_token to their user and their linked characters.
 *
 * Deliberately the same credential the /api/character/* CSV endpoints use:
 * the FUSE client is a long-lived daemon on someone's laptop, and asking it to
 * carry a refreshable OAuth session (as the MCP server does) would mean a
 * token store, a refresh loop, and a re-auth prompt in a program whose whole
 * job is to look like a folder. The api_token is revocable from
 * /account/settings, which is the property that matters.
 *
 * The client returned is the SERVICE role, so every query below scopes itself
 * to the resolved registrations by hand. There is no RLS backstop here.
 */
export const authorize = async (request: Request): Promise<Caller | Failure> => {
  const token = bearerToken(request)
  if (!token) return failure(401, 'Missing api token. Send it as `Authorization: Bearer <token>`.')

  const supabase = createServiceClient()
  const { data: settings, error: settingsError } = await supabase
    .from('user_settings')
    .select('user_id')
    .eq('api_token', token)
    .maybeSingle<{ user_id: string }>()
  if (settingsError) return failure(500, 'Lookup failed')
  if (!settings) return failure(401, 'Invalid api token')

  const { data: registrations, error: registrationsError } = await supabase
    .from('registration')
    .select('id, character_id, name')
    .eq('user_id', settings.user_id)
    .not('character_id', 'is', null)
    .order('name', { ascending: true })
    .returns<Array<{ id: string; character_id: number | string; name: string | null }>>()
  if (registrationsError) return failure(500, 'Lookup failed')

  return {
    supabase,
    userId: settings.user_id,
    registrations: (registrations ?? []).map((r) => ({
      registration_id: r.id,
      character_id: String(r.character_id),
      name: r.name,
    })),
  }
}

export const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && 'status' in value && 'error' in value

/**
 * One of the caller's own characters, by EVE character id. Never resolves a
 * character shared *in* from someone else: a fit you can see through a share is
 * still not one you may delete out of its owner's game client.
 */
export const ownCharacter = (caller: Caller, characterId: string): Registration | Failure =>
  caller.registrations.find((r) => r.character_id === characterId) ??
  failure(404, `No character ${characterId} on this account.`)

/**
 * A fresh ESI access token for one character, carrying `scope`.
 *
 * Refreshed unconditionally rather than reusing a stored access_token that may
 * be minutes from expiry — the same thing forEachCharacter does before every
 * extract, and the refresh doubles as the check that the grant is still live.
 */
export const esiToken = async (
  caller: Caller,
  registration: Registration,
  scope: string
): Promise<{ access_token: string } | Failure> => {
  const { data: tokens, error } = await caller.supabase
    .from('token')
    .select('id, refresh_token, scope')
    .eq('registration_id', registration.registration_id)
    .contains('scope', [scope])
    .order('expires_at', { ascending: false })
    .limit(1)
    .returns<Array<{ id: number; refresh_token: string; scope: string[] }>>()
  if (error) return failure(500, 'Token lookup failed')

  const tokenRow = tokens?.[0]
  if (!tokenRow) {
    return failure(
      403,
      scope === WRITE_SCOPE
        ? `${registration.name ?? registration.character_id} has not granted permission to save and delete fittings. Enable it under ESI Access in settings, then re-add the character.`
        : `${registration.name ?? registration.character_id} has not granted permission to read fittings.`
    )
  }

  try {
    // Imported here rather than at the top of the file: src/tokenRefresh.js
    // pulls in src/supabase.js, which builds its service client at module
    // evaluation and throws without SUPABASE_SERVICE_KEY. That would fail the
    // build's page-data collection, which runs with no environment at all.
    const { refreshAccessToken } = await import('@/tokenRefresh')
    // The refresh returns the scopes EVE still recognizes; a grant revoked on
    // CCP's side comes back short even though our stored row still lists it.
    const refreshed = await refreshAccessToken(tokenRow)
    if (!(refreshed.scope ?? []).includes(scope)) {
      return failure(
        403,
        `The EVE grant for ${registration.name ?? registration.character_id} no longer covers ${scope}.`
      )
    }
    return { access_token: refreshed.access_token }
  } catch {
    return failure(403, `Could not refresh the EVE token for ${registration.name ?? registration.character_id}.`)
  }
}

/** The character's fitting library as EVE has it right now, straight from ESI. */
export const liveFittings = async (accessToken: string, characterId: string): Promise<ArchiveFitting[]> => {
  const { json } = await fetchFittings(accessToken, characterId)
  return (json ?? []).map((f: Record<string, unknown>) => ({
    fitting_id: Number(f.fitting_id),
    name: String(f.name ?? ''),
    description: String(f.description ?? ''),
    ship_type_id: Number(f.ship_type_id),
    items: normalizeItems(f.items),
  }))
}

type LogEntry = {
  op: 'create' | 'delete'
  fitting_id: number | null
  fitting: FittingBody
  source: string
  /** The caller's own key for a restore; null for a delete. */
  request_id?: string | null
}

// Open a fitting_write_log row before touching ESI, and hand back the closers.
//
// The insert is the point: it puts the whole fit — name, ship, every module —
// on disk on our side while CCP still has it. If everything after this throws,
// the row stays 'pending' and the fit is recoverable from it whether or not the
// delete went through. See the table comment in schema.sql.
const openLog = async (caller: Caller, registration: Registration, entry: LogEntry) => {
  const { data, error } = await caller.supabase
    .from('fitting_write_log')
    .insert({
      user_id: caller.userId,
      registration_id: registration.registration_id,
      op: entry.op,
      fitting_id: entry.fitting_id,
      request_id: entry.request_id ?? null,
      name: entry.fitting.name,
      description: entry.fitting.description,
      ship_type_id: entry.fitting.ship_type_id,
      items: entry.fitting.items,
      content_hash: contentHash(entry.fitting),
      source: entry.source,
      status: 'pending',
    })
    .select('id')
    .single<{ id: number }>()
  if (error || !data) throw new Error(`fitting_write_log insert failed: ${error?.message ?? 'no row'}`)

  const close = async (status: 'ok' | 'error', patch: { fitting_id?: number; error?: string } = {}) => {
    await caller.supabase
      .from('fitting_write_log')
      .update({ status, finished_at: new Date().toISOString(), ...patch })
      .eq('id', data.id)
  }
  return {
    succeeded: (patch?: { fitting_id?: number }) => close('ok', patch),
    failed: (message: string) => close('error', { error: message.slice(0, 1000) }),
  }
}

/**
 * Archive one fitting: verify it, record it, delete it from the game, and close
 * its local row so the next listing agrees.
 *
 * Order is the whole design. The live fetch first, because the extract's copy
 * can be six hours old and the fit may have been edited in the client since —
 * deleting on the strength of a stale row would destroy a version nobody ever
 * stored. Then the log insert, holding whatever ESI *currently* says the fit
 * is. Only then the DELETE.
 */
export const archiveFitting = async (
  caller: Caller,
  registration: Registration,
  fittingId: number,
  source: string
): Promise<{ archived: ArchiveFitting } | Failure> => {
  const token = await esiToken(caller, registration, WRITE_SCOPE)
  if (isFailure(token)) return token

  let live: ArchiveFitting[]
  try {
    live = await liveFittings(token.access_token, registration.character_id)
  } catch (e) {
    return failure(502, `EVE would not list this character's fittings: ${(e as Error).message}`)
  }

  const fit = live.find((f) => f.fitting_id === fittingId)
  if (!fit) {
    // Already gone from the game — someone deleted it in the client, or a
    // previous attempt got further than it reported. Converge the local row
    // instead of failing: the filesystem asked for it to not be there.
    await closeLocalFitting(caller, registration, fittingId)
    return failure(404, `EVE has no fitting ${fittingId} saved for ${registration.name ?? registration.character_id}.`)
  }

  const log = await openLog(caller, registration, { op: 'delete', fitting_id: fittingId, fitting: fit, source })
  try {
    await deleteFitting(token.access_token, registration.character_id, fittingId)
  } catch (e) {
    await log.failed((e as Error).message)
    return failure(502, `EVE refused the delete: ${(e as Error).message}`)
  }
  await log.succeeded()
  await closeLocalFitting(caller, registration, fittingId)
  return { archived: fit }
}

/**
 * The fitting a completed restore under this request id produced, if it has
 * already run. This is what makes PUT mean what PUT is supposed to mean: the
 * same request replayed lands on the same row and reports the same fitting,
 * without a second thought given to CCP.
 */
const replayedRestore = async (caller: Caller, registration: Registration, requestId: string) => {
  const { data } = await caller.supabase
    .from('fitting_write_log')
    .select('fitting_id, status')
    .eq('request_id', requestId)
    .eq('registration_id', registration.registration_id)
    .maybeSingle<{ fitting_id: number | null; status: string }>()
  // A 'pending' row is a crashed or in-flight attempt, not an answer: fall
  // through and let the live-ESI content check decide what actually happened.
  return data?.status === 'ok' && data.fitting_id != null ? Number(data.fitting_id) : null
}

/**
 * Restore one fitting into the game, under a key the caller minted.
 *
 * Two independent guards against saving the same fit twice, because they cover
 * different accidents:
 *
 *   * `requestId` catches a **retried request** — a lost response, a `cp` the
 *     kernel reissued. Same key, same answer, no second call to CCP.
 *   * the **content hash** catches the same *fit* arriving under a fresh key,
 *     which is the ordinary case: copying the same archive file in twice mints
 *     a new GUID each time, and only the content can tell you the game already
 *     has it.
 *
 * Guarded against the 500-slot cap using EVE's own count rather than our
 * mirror's, since the mirror is as stale as the last extract.
 */
export const restoreFitting = async (
  caller: Caller,
  registration: Registration,
  requestId: string,
  fitting: FittingBody,
  source: string
): Promise<{ fitting_id: number; created: boolean } | Failure> => {
  const replayed = await replayedRestore(caller, registration, requestId)
  if (replayed !== null) return { fitting_id: replayed, created: false }

  const token = await esiToken(caller, registration, WRITE_SCOPE)
  if (isFailure(token)) return token

  let live: ArchiveFitting[]
  try {
    live = await liveFittings(token.access_token, registration.character_id)
  } catch (e) {
    return failure(502, `EVE would not list this character's fittings: ${(e as Error).message}`)
  }

  const hash = contentHash(fitting)
  const resident = live.find((f) => contentHash(f) === hash)
  if (resident) return { fitting_id: resident.fitting_id, created: false }

  if (live.length >= FITTING_SLOTS) {
    return failure(
      507,
      `${registration.name ?? registration.character_id} already has ${live.length} of ${FITTING_SLOTS} fittings saved in EVE. Archive one first.`
    )
  }

  const log = await openLog(caller, registration, {
    op: 'create',
    fitting_id: null,
    fitting,
    source,
    request_id: requestId,
  })
  let created: { fitting_id: number }
  try {
    created = await createFitting(token.access_token, registration.character_id, fitting)
  } catch (e) {
    await log.failed((e as Error).message)
    return failure(502, `EVE refused the fitting: ${(e as Error).message}`)
  }
  await log.succeeded({ fitting_id: Number(created.fitting_id) })
  await openLocalFitting(caller, registration, Number(created.fitting_id), fitting)
  return { fitting_id: Number(created.fitting_id), created: true }
}

// ── Keeping the local mirror honest ──────────────────────────────────────
//
// character_fitting_over_time is written by the character-fittings extract
// every six hours. Waiting for it after a write would leave the filesystem
// showing a file it just deleted (or missing one it just restored) for hours,
// so both writes converge the SCD rows themselves, in exactly the shape the
// extract would have. The next extract then agrees rather than churning.

const closeLocalFitting = async (caller: Caller, registration: Registration, fittingId: number) => {
  await caller.supabase
    .from('character_fitting_over_time')
    .update({ is_current: false })
    .eq('registration_id', registration.registration_id)
    .eq('fitting_id', fittingId)
    .eq('is_current', true)
}

const openLocalFitting = async (
  caller: Caller,
  registration: Registration,
  fittingId: number,
  fitting: FittingBody
) => {
  // Close first: the unique-current-per-fitting index would reject the insert
  // if EVE reused an id we still hold open.
  await closeLocalFitting(caller, registration, fittingId)
  await caller.supabase.from('character_fitting_over_time').insert({
    registration_id: registration.registration_id,
    owner_scope: 'character',
    fitting_id: fittingId,
    name: fitting.name,
    description: fitting.description,
    ship_type_id: fitting.ship_type_id,
    items: fitting.items,
    valid_until: new Date().toISOString(),
  })
}
