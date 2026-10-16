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
import { randomUUID } from 'node:crypto'

import { NextResponse } from 'next/server'

import { createFitting, deleteFitting, fittings as fetchFittings } from '@/esi'
import {
  type ArchiveFitting,
  contentHash,
  FITTING_SLOTS,
  type FittingBody,
  type FittingItem,
  normalizeItems,
} from '@/fittingArchive'
import { createServiceClient } from '@/utils/supabase/service'

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

export type Failure = {
  status: number
  error: string
  /** Extra fields merged into the error body — a conflict says what it collided with. */
  detail?: Record<string, unknown>
}

const failure = (status: number, error: string, detail?: Record<string, unknown>): Failure => ({
  status,
  error,
  ...(detail ? { detail } : {}),
})

/** A Failure as the JSON body every route in this tree answers errors with. */
export const errorResponse = (f: Failure): NextResponse =>
  NextResponse.json({ error: f.error, ...f.detail }, { status: f.status })

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

  return callerForUser(settings.user_id, supabase)
}

/**
 * The service-role `Caller` for a user whose identity is already proved —
 * by the api_token above, or by a cookie session in a server action
 * (src/app/fitting/marshalActions.ts). The two halves of authorize() split
 * here so the web buttons and the FUSE routes run the same write functions on
 * the same object; the proof of identity is the only thing that differs.
 */
export const callerForUser = async (userId: string, supabase = createServiceClient()): Promise<Caller | Failure> => {
  const { data: registrations, error: registrationsError } = await supabase
    .from('registration')
    .select('id, character_id, name')
    .eq('user_id', userId)
    .not('character_id', 'is', null)
    .order('name', { ascending: true })
    .returns<Array<{ id: string; character_id: number | string; name: string | null }>>()
  if (registrationsError) return failure(500, 'Lookup failed')

  return {
    supabase,
    userId,
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
        ? `${registration.name ?? registration.character_id} has not granted permission to save and delete fittings. Turn on "Save and delete fittings" under /settings/grants, then re-auth the character on /account/registrations.`
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
  // 23505 is Postgres's unique_violation: another request already claimed this
  // id, either concurrently or a moment ago. The unique index is what actually
  // enforces use-once — the read below it is only the fast path — so this is
  // the branch that holds under two PUTs racing for the same key.
  if (error?.code === '23505') return 'taken' as const
  if (error || !data) throw new Error(`fitting_write_log insert failed: ${error?.message ?? 'no row'}`)

  const close = async (status: 'ok' | 'error', patch: { fitting_id?: number; error?: string } = {}) => {
    await caller.supabase
      .from('fitting_write_log')
      .update({ status, finished_at: new Date().toISOString(), ...patch })
      .eq('id', data.id)
  }
  return {
    id: data.id,
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
): Promise<{ archived: ArchiveFitting; writeLogId: number } | Failure> => {
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
  // Unreachable: a delete carries no request_id, and the unique index that
  // returns 'taken' excludes nulls. Narrowed rather than asserted, so the day
  // deletes grow a key this is a refusal and not a crash.
  if (log === 'taken') return failure(409, 'That delete has already been recorded.')
  try {
    await deleteFitting(token.access_token, registration.character_id, fittingId)
  } catch (e) {
    await log.failed((e as Error).message)
    return failure(502, `EVE refused the delete: ${(e as Error).message}`)
  }
  await log.succeeded()
  await closeLocalFitting(caller, registration, fittingId)
  return { archived: fit, writeLogId: log.id }
}

/**
 * A restore key is used once.
 *
 * PUT to a key that has already been used is a `409`, not a replayed success:
 * the id names one attempt, and reusing it means the caller has lost track of
 * which of its writes went through — worth telling them, rather than papering
 * over with the previous answer. Uuids are free; mint another.
 *
 * It stays idempotent in the sense that matters, because idempotency is about
 * effects and not status codes: however many times that PUT arrives, the
 * character ends up with exactly one fitting from it. A client retrying after
 * a lost response gets the `409` — which carries the `fitting_id` the first
 * attempt produced, so "already done, here's what it did" is still an answer
 * it can act on.
 *
 * Any row counts, whatever its status. A `pending` row is a crashed or
 * in-flight attempt and an `error` row is a failed one; in both cases that id
 * has been spent and the honest answer is that it isn't available.
 */
const claimedRequest = async (caller: Caller, registration: Registration, requestId: string) => {
  const { data } = await caller.supabase
    .from('fitting_write_log')
    .select('fitting_id, status')
    .eq('request_id', requestId)
    .eq('registration_id', registration.registration_id)
    .maybeSingle<{ fitting_id: number | null; status: string }>()
  return data ?? null
}

const conflict = (requestId: string, claimed: { fitting_id: number | null; status: string } | null): Failure =>
  failure(409, `Request id ${requestId} has already been used. Mint a new one.`, {
    request_id: requestId,
    ...(claimed?.fitting_id != null ? { fitting_id: Number(claimed.fitting_id) } : {}),
    ...(claimed?.status ? { previous_status: claimed.status } : {}),
  })

/**
 * Restore one fitting into the game, under a key the caller minted.
 *
 * Two independent guards against saving the same fit twice, because they cover
 * different accidents:
 *
 *   * `requestId` is **used once**: a second PUT to the same key is a 409, so a
 *     repeated request can never become a second fitting, whatever the body
 *     says.
 *   * the **content hash** catches the same *fit* arriving under a fresh key,
 *     which is the ordinary case: copying the same archive file in twice mints
 *     a new uuid each time, and only the content can tell you the game already
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
  const claimed = await claimedRequest(caller, registration, requestId)
  if (claimed) return conflict(requestId, claimed)

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
  // Lost the race to another PUT holding the same key between the read above
  // and this insert.
  if (log === 'taken') return conflict(requestId, await claimedRequest(caller, registration, requestId))
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

// ── The marshalled archive ──────────────────────────────────────────────────
//
// marshalled_fitting (docs/fitting-marshal.md): a fit that is ours but not in
// the game, held at account level and addressed by its content hash. Nothing
// in this section talks to ESI — these are the store half that `marshalFitting`
// (PR 2) pairs with `archiveFitting`, and that the /api/fittings/marshalled
// routes expose on their own so a disk archive can move into Supabase without
// a slot ever changing hands.
//
// Written through the service-role `Caller` after the request proved who it
// is, like fitting_write_log; every query scopes itself to caller.userId by
// hand, since there is no RLS backstop on this client.

export type MarshalledRow = {
  user_id: string
  content_hash: string
  name: string
  description: string
  ship_type_id: number | string
  items: FittingItem[]
  source_registration_id: string | null
  source_fitting_id: number | string | null
  write_log_id: number | string | null
  source: string
  marshalled_at: string
}

/** Where a stored fit came from. Only `source` is known for a file copied in. */
export type MarshalledProvenance = {
  source: string
  registration?: Registration
  fittingId?: number
  writeLogId?: number
}

const MARSHALLED_COLUMNS =
  'user_id, content_hash, name, description, ship_type_id, items, source_registration_id, source_fitting_id, write_log_id, source, marshalled_at'

/**
 * What asked for a write: the FUSE client tags its requests, anything else
 * carrying the api_token is 'api'. The web buttons (PR 2) pass 'web' directly.
 */
export const requestSource = (request: Request): string =>
  request.headers.get('x-edencom-source') === 'fuse' ? 'fuse' : 'api'

/** Every marshalled fit on the account, newest first. */
export const listMarshalled = async (caller: Caller): Promise<MarshalledRow[] | Failure> => {
  const { data, error } = await caller.supabase
    .from('marshalled_fitting')
    .select(MARSHALLED_COLUMNS)
    .eq('user_id', caller.userId)
    .order('marshalled_at', { ascending: false })
    .returns<MarshalledRow[]>()
  if (error) return failure(500, 'Query failed')
  return data ?? []
}

export const readMarshalled = async (
  caller: Caller,
  contentHashHex: string
): Promise<MarshalledRow | null | Failure> => {
  const { data, error } = await caller.supabase
    .from('marshalled_fitting')
    .select(MARSHALLED_COLUMNS)
    .eq('user_id', caller.userId)
    .eq('content_hash', contentHashHex)
    .maybeSingle<MarshalledRow>()
  if (error) return failure(500, 'Query failed')
  return data ?? null
}

/**
 * Put a fit in the archive. Idempotent on (user_id, content_hash): the same
 * fit stored again — marshalled from a second alt, or `cp`'d in twice — is one
 * row whose provenance and `marshalled_at` move to the latest store, because
 * the slot was still freed, which is what the player asked for. `created`
 * says whether the row is new, for the route's 201/200.
 */
export const storeMarshalled = async (
  caller: Caller,
  fitting: FittingBody,
  provenance: MarshalledProvenance
): Promise<{ content_hash: string; created: boolean } | Failure> => {
  const hash = contentHash(fitting)
  const existing = await readMarshalled(caller, hash)
  if (isFailure(existing)) return existing

  const { error } = await caller.supabase.from('marshalled_fitting').upsert(
    {
      user_id: caller.userId,
      content_hash: hash,
      name: fitting.name,
      description: fitting.description,
      ship_type_id: fitting.ship_type_id,
      items: normalizeItems(fitting.items),
      source_registration_id: provenance.registration?.registration_id ?? null,
      source_fitting_id: provenance.fittingId ?? null,
      write_log_id: provenance.writeLogId ?? null,
      source: provenance.source,
      marshalled_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,content_hash' }
  )
  if (error) return failure(500, `Storing the fitting failed: ${error.message}`)
  return { content_hash: hash, created: existing === null }
}

/** Remove a fit from the archive. True if there was one. Permanent; no ESI. */
export const deleteMarshalled = async (caller: Caller, contentHashHex: string): Promise<boolean | Failure> => {
  const { data, error } = await caller.supabase
    .from('marshalled_fitting')
    .delete()
    .eq('user_id', caller.userId)
    .eq('content_hash', contentHashHex)
    .select('content_hash')
    .returns<Array<{ content_hash: string }>>()
  if (error) return failure(500, 'Delete failed')
  return (data ?? []).length > 0
}

/**
 * The archive file for a marshalled fit: ESI's fitting object, as
 * `toArchiveFitting` renders a live one. `fitting_id` is the id the fit had
 * in game when it was marshalled, carried because ESI's object carries it and
 * ignored on restore; a fit copied in from a file arrived without one, and
 * then the key is simply absent rather than invented.
 */
export const toMarshalledFile = (row: MarshalledRow): FittingBody & { fitting_id?: number } => ({
  ...(row.source_fitting_id != null ? { fitting_id: Number(row.source_fitting_id) } : {}),
  name: row.name,
  description: row.description,
  ship_type_id: Number(row.ship_type_id),
  items: normalizeItems(row.items),
})

/**
 * The listing entry for one marshalled fit: the archive file plus the handle
 * to address it by, the hull name for the filename, and where it came from.
 * Shared by GET /api/fittings/marshalled and the `marshalled` array GET
 * /api/fittings carries beside `characters`, so a mount builds its whole tree
 * from one response.
 */
export const marshalledEntry = (caller: Caller, shipNames: Record<number, string>, row: MarshalledRow) => ({
  ...toMarshalledFile(row),
  content_hash: row.content_hash,
  ship_name: shipNames[Number(row.ship_type_id)] ?? null,
  marshalled_at: row.marshalled_at,
  source: row.source,
  // The EVE id of the character it came from, while that character is still
  // on the account (the column nulls when it is unlinked; a file copied in
  // never had one). Resolved from the caller's own registrations, never from
  // anything an audience could read — the archive is the owner's alone.
  source_character_id:
    caller.registrations.find((r) => r.registration_id === row.source_registration_id)?.character_id ?? null,
  // Doubles as the file's mtime in the mount, like `modified` on a live fit.
  modified: row.marshalled_at,
})

// ── Marshal, unmarshal, transfer ────────────────────────────────────────────
//
// The three verbs of docs/fitting-marshal.md, each a composition of the two
// ESI writes above with the store. They live here, and only here, so "every
// ESI write is in this one file" stays true for the web buttons and the mount
// alike; the routes and the server actions are thin callers with different
// proofs of identity.

/** The share row a fit had, if any, cannot follow it: a marshalled fit has no
 *  (registration, fitting_id), and a restored one gets a new id. Best effort —
 *  a failure here leaves a share pointing at a closed row, which RLS already
 *  shows nobody. */
const dropFittingShare = async (caller: Caller, registration: Registration, fittingId: number) => {
  await caller.supabase
    .from('character_fitting_share')
    .delete()
    .eq('registration_id', registration.registration_id)
    .eq('fitting_id', fittingId)
}

/**
 * Marshal: delete the fit from the game and keep it here.
 *
 * Step 1 is the whole safety story (live fetch, log row first, DELETE, close
 * the mirror row). Step 2 stores what ESI handed back at the moment of the
 * delete — never the mirror's copy — with the log row as provenance. If step
 * 1 fails nothing is stored; if step 2 fails after a successful delete the log
 * row still holds the fit (`op = 'delete'`, `status = 'ok'`), which is the
 * position every FUSE `rm` has always been in.
 */
export const marshalFitting = async (
  caller: Caller,
  registration: Registration,
  fittingId: number,
  source: string
): Promise<{ archived: ArchiveFitting; content_hash: string } | Failure> => {
  const result = await archiveFitting(caller, registration, fittingId, source)
  if (isFailure(result)) return result

  const stored = await storeMarshalled(caller, result.archived, {
    source,
    registration,
    fittingId,
    writeLogId: result.writeLogId,
  })
  if (isFailure(stored)) {
    return failure(
      500,
      `EVE deleted the fitting but storing it here failed (${stored.error}). It is kept in fitting_write_log row ${result.writeLogId}.`,
      { write_log_id: result.writeLogId }
    )
  }
  await dropFittingShare(caller, registration, fittingId)
  return { archived: result.archived, content_hash: stored.content_hash }
}

/**
 * Unmarshal: save a marshalled fit back into the game on `registration`.
 *
 * A fresh request id per call — the key names this attempt, nothing else.
 * `restoreFitting` already answers the existing id (`created: false`) when
 * the character holds the same content, and 507 when all 500 slots are full.
 * The archive row is deleted only after the restore succeeded, so a refused
 * restore leaves the fit where it was.
 */
export const unmarshalFitting = async (
  caller: Caller,
  contentHashHex: string,
  registration: Registration,
  source: string
): Promise<{ fitting_id: number; created: boolean; characterId: string } | Failure> => {
  const row = await readMarshalled(caller, contentHashHex)
  if (isFailure(row)) return row
  if (!row) return failure(404, 'No such marshalled fitting on this account.')

  const body: FittingBody = {
    name: row.name,
    description: row.description,
    ship_type_id: Number(row.ship_type_id),
    items: normalizeItems(row.items),
  }
  const restored = await restoreFitting(caller, registration, randomUUID(), body, source)
  if (isFailure(restored)) return restored

  const deleted = await deleteMarshalled(caller, contentHashHex)
  if (isFailure(deleted)) return deleted
  return { ...restored, characterId: registration.character_id }
}

/**
 * Transfer: the fit saved on `to`, then deleted from `from`. The copy is made
 * BEFORE the original is removed, so no failure can lose the fit: a refused
 * restore changes nothing, and a refused delete after a successful restore
 * leaves it on both characters — safe, retryable, reported rather than rolled
 * back (`transferOutcome` in marshalOutcome.ts turns the two step results into
 * the message and the redirect). The body is `from`'s LIVE copy, for the same
 * reason archiveFitting verifies live.
 */
export const transferFitting = async (
  caller: Caller,
  from: Registration,
  to: Registration,
  fittingId: number,
  source: string
): Promise<TransferSteps | Failure> => {
  if (from.registration_id === to.registration_id) {
    return failure(400, 'Transfer needs two different characters.')
  }

  const token = await esiToken(caller, from, WRITE_SCOPE)
  if (isFailure(token)) return token
  let live: ArchiveFitting[]
  try {
    live = await liveFittings(token.access_token, from.character_id)
  } catch (e) {
    return failure(502, `EVE would not list this character's fittings: ${(e as Error).message}`)
  }
  const fit = live.find((f) => f.fitting_id === fittingId)
  if (!fit) {
    await closeLocalFitting(caller, from, fittingId)
    return failure(404, `EVE has no fitting ${fittingId} saved for ${from.name ?? from.character_id}.`)
  }

  const body: FittingBody = {
    name: fit.name,
    description: fit.description,
    ship_type_id: fit.ship_type_id,
    items: fit.items,
  }
  const restored = await restoreFitting(caller, to, randomUUID(), body, source)
  if (isFailure(restored)) return { restored }

  const archived = await archiveFitting(caller, from, fittingId, source)
  if (!isFailure(archived)) await dropFittingShare(caller, from, fittingId)
  return { restored, archived }
}

/** The two step results of a transfer, for `transferOutcome` to reduce. */
export type TransferSteps = {
  restored: { fitting_id: number; created: boolean } | Failure
  archived?: { archived: ArchiveFitting; writeLogId: number } | Failure
}
