// Sending EVE mail as one of the caller's characters (docs/eve-mail.md "The
// send path"). Server-only: the second ESI write path after
// src/app/api/fittings/lib.ts, and built the same way — the whole draft goes
// into mail_send_log BEFORE ESI is called, under a caller-minted request id
// that is used once, so a client that lost a response can retry without the
// mail going out twice.
//
// Two verbs (docs/eve-mail.md "Approval on the website"):
//
//   enqueueMail  — validate the draft and hold it on the site as a 'queued'
//                  mail_send_log row. Nothing reaches ESI. What the MCP
//                  `send_mail` tool (src/app/api/mcp/mailTools.ts) does, and
//                  all it does: a person sends the queue later, by hand.
//   sendMail     — the real send: log 'pending', call ESI, log ok/error.
//                  Called by `pnpm run mail-send` (src/mailSend.ts) for a
//                  fresh draft, and through sendQueuedMail for a queued row.
//
// No page on the site calls either. Every caller hands over a Caller on the
// service role (the CLI builds one, the tool takes callerForUser's), so every
// query below scopes itself to the caller's registrations by hand.
//
// Imports are relative with extensions, and the fittings types `import type`
// only, so the CLI can run this file under plain `node` (type stripping) as
// well as through the Next build. No `server-only` marker for the same reason:
// it throws outside the react-server condition, which a CLI never has.
import type { Caller, Failure, Registration } from '../api/fittings/lib.ts'

import { sendMail as esiSendMail } from '../../esi.js'
import { type MailDraft, type Recipient, type ValidDraft, validateDraft } from '../../mailCompose.ts'

export const SEND_SCOPE = 'esi-mail.send_mail.v1'

export type SendOutcome = { ok: true; mailId: number; logId: number } | Failure
export type EnqueueOutcome = { ok: true; logId: number; requestId: string } | Failure

/** One row of the queue: a mail a person still has to send. */
export type QueuedMail = {
  id: number
  registration_id: string
  request_id: string
  recipients: Recipient[]
  subject: string
  body: string
  approved_cost: number
  source: string
  created_at: string
}

const failure = (status: number, error: string, detail?: Record<string, unknown>): Failure => ({
  status,
  error,
  ...(detail ? { detail } : {}),
})

const nameOf = (registration: Registration) => registration.name ?? registration.character_id

/**
 * A fresh access token for `registration` carrying the send grant. The
 * fittings lib's esiToken, for this scope: refreshed unconditionally, and the
 * refresh's own scope list is the check that the grant is still live at CCP.
 */
const sendToken = async (caller: Caller, registration: Registration): Promise<{ access_token: string } | Failure> => {
  const { data: tokens, error } = await caller.supabase
    .from('token')
    .select('id, refresh_token, scope')
    .eq('registration_id', registration.registration_id)
    .contains('scope', [SEND_SCOPE])
    .order('expires_at', { ascending: false })
    .limit(1)
    .returns<Array<{ id: number; refresh_token: string; scope: string[] }>>()
  if (error) return failure(500, 'Token lookup failed')

  const tokenRow = tokens?.[0]
  if (!tokenRow) {
    return failure(
      403,
      `${nameOf(registration)} has not granted permission to send mail. Turn on "Send in-game mail" under /settings/grants, then re-auth the character on /account/registrations.`
    )
  }

  try {
    // Lazily, as the fittings lib does: src/tokenRefresh.js pulls in
    // src/supabase.js, which builds a service client at module evaluation and
    // throws without SUPABASE_SERVICE_KEY — fatal to the build's page-data
    // collection, which runs with no environment.
    const { refreshAccessToken } = await import('../../tokenRefresh.js')
    const refreshed = await refreshAccessToken(tokenRow)
    if (!(refreshed.scope ?? []).includes(SEND_SCOPE)) {
      return failure(403, `The EVE grant for ${nameOf(registration)} no longer covers ${SEND_SCOPE}.`)
    }
    return { access_token: refreshed.access_token }
  } catch {
    return failure(403, `Could not refresh the EVE token for ${nameOf(registration)}.`)
  }
}

/**
 * Whether one of the caller's characters holds a token carrying the send
 * grant, read from our own row with no refresh — what send_mail's preview
 * answers. A send still refreshes the token (sendToken), which is the check
 * that CCP has not revoked the grant since.
 */
export const sendGrantHeld = async (caller: Caller, registrationId: string): Promise<boolean> => {
  if (!caller.registrations.some((r) => r.registration_id === registrationId)) return false
  const { data, error } = await caller.supabase
    .from('token')
    .select('id')
    .eq('registration_id', registrationId)
    .contains('scope', [SEND_SCOPE])
    .limit(1)
  return !error && (data ?? []).length > 0
}

type SpentRequest = { mail_id: number | null; status: string } | null

const spentRequest = async (caller: Caller, requestId: string): Promise<SpentRequest> => {
  const { data } = await caller.supabase
    .from('mail_send_log')
    .select('mail_id, status')
    .eq('request_id', requestId)
    .eq('user_id', caller.userId)
    .maybeSingle<{ mail_id: number | null; status: string }>()
  return data ?? null
}

// A reused id is a 409, never a replayed success — the fitting_write_log rule
// (see claimedRequest in the fittings lib): the id names one attempt, and any
// row spends it whatever its status. The previous outcome rides along when the
// row is the caller's own, so "already sent, here is its mail id" is still an
// answer a retrying client can act on.
const conflict = (requestId: string, spent: SpentRequest): Failure =>
  failure(409, `Request id ${requestId} has already been used. Mint a new one.`, {
    request_id: requestId,
    ...(spent?.mail_id != null ? { mail_id: Number(spent.mail_id) } : {}),
    ...(spent?.status ? { previous_status: spent.status } : {}),
  })

// The closer of one mail_send_log row: the send's outcome, written once.
const closerOf = (caller: Caller, id: number) => {
  const close = async (patch: { status: 'ok'; mail_id: number } | { status: 'error'; error: string }) => {
    await caller.supabase
      .from('mail_send_log')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', id)
  }
  return {
    id,
    succeeded: (mailId: number) => close({ status: 'ok', mail_id: mailId }),
    failed: (message: string) => close({ status: 'error', error: message.slice(0, 1000) }),
  }
}

// Open the mail_send_log row. The insert is the point: the draft is on our
// side before CCP has it, so a crash after this leaves a 'pending' row saying
// exactly what may or may not have gone out — or a 'queued' one that is simply
// still waiting for a person.
const openLog = async (
  caller: Caller,
  registration: Registration,
  draft: ValidDraft,
  source: string,
  status: 'queued' | 'pending'
) => {
  const { data, error } = await caller.supabase
    .from('mail_send_log')
    .insert({
      user_id: caller.userId,
      registration_id: registration.registration_id,
      request_id: draft.requestId,
      recipients: draft.recipients,
      subject: draft.subject,
      body: draft.body,
      approved_cost: draft.approvedCost,
      source,
      status,
    })
    .select('id')
    .single<{ id: number }>()
  // 23505 = unique_violation on mail_send_log_request_id_idx: the index, not
  // any read before it, is what makes the id use-once under a race.
  if (error?.code === '23505') return 'taken' as const
  if (error || !data) throw new Error(`mail_send_log insert failed: ${error?.message ?? 'no row'}`)
  return data.id
}

// ESI's CSPA refusal. Reported, never retried with a higher approved_cost:
// spending the player's ISK is a decision only the caller makes, explicitly.
const isCspaRefusal = (e: unknown) => (e as { status?: number })?.status === 520

// The one place ESI is called: a 'pending' row exists, the draft is valid,
// the character is the caller's. Closes the row with the outcome.
const deliver = async (
  caller: Caller,
  registration: Registration,
  draft: ValidDraft,
  logId: number
): Promise<SendOutcome> => {
  const log = closerOf(caller, logId)
  const token = await sendToken(caller, registration)
  if ('error' in token) {
    await log.failed(token.error)
    return token
  }

  let mailId: number
  try {
    mailId = await esiSendMail(token.access_token, registration.character_id, {
      subject: draft.subject,
      body: draft.body,
      recipients: draft.recipients,
      approved_cost: draft.approvedCost,
    })
  } catch (e) {
    const message = (e as Error).message
    await log.failed(message)
    return isCspaRefusal(e)
      ? failure(
          402,
          `EVE refused the mail: a recipient's CSPA charge exceeds the approved ${draft.approvedCost} ISK. Nothing was retried; send again under a new request id with a higher approved cost if that is intended.`,
          { log_id: log.id }
        )
      : failure(502, `EVE refused the mail: ${message}`, { log_id: log.id })
  }

  if (!Number.isSafeInteger(mailId) || mailId <= 0) {
    // ESI said 201 but not with a mail id. The mail almost certainly went out,
    // so the row must not read as a clean failure either.
    await log.failed(`ESI accepted the send but answered with no mail id (${String(mailId)}).`)
    return failure(502, 'EVE accepted the mail but did not say which it was.', { log_id: log.id })
  }

  await log.succeeded(mailId)
  return { ok: true, mailId, logId: log.id }
}

// Own character and a valid draft, or the Failure that says why not. The
// gate both verbs share.
const admit = (
  caller: Caller,
  registrationId: string,
  draft: MailDraft
): { registration: Registration; draft: ValidDraft } | Failure => {
  const registration = caller.registrations.find((r) => r.registration_id === registrationId)
  if (!registration) return failure(404, `No character ${registrationId} on this account.`)
  const verdict = validateDraft(draft)
  if (!verdict.ok) return failure(400, 'The draft cannot be sent.', { reasons: verdict.reasons })
  return { registration, draft: verdict.draft }
}

/**
 * Send one mail as `registrationId`, which must be one of the caller's own
 * characters — never one shared in from someone else.
 *
 * Order: own character → valid draft → log row `pending` (a reused request id
 * is a 409 here, before anything reaches EVE) → token carrying the send grant
 * → ESI → log row `ok` with ESI's mail id, or `error` with its message.
 *
 * Writes nothing to character_mail: the sent mail reaches it on the next
 * character-mail extract, through the Sent label.
 */
export const sendMail = async (
  caller: Caller,
  registrationId: string,
  draft: MailDraft,
  source = 'cli'
): Promise<SendOutcome> => {
  const admitted = admit(caller, registrationId, draft)
  if ('error' in admitted) return admitted

  const logId = await openLog(caller, admitted.registration, admitted.draft, source, 'pending')
  if (logId === 'taken') return conflict(admitted.draft.requestId, await spentRequest(caller, admitted.draft.requestId))

  return deliver(caller, admitted.registration, admitted.draft, logId)
}

/**
 * Hold one mail on the site for a person to send later. Same gate as sendMail
 * — own character, valid draft, use-once request id — plus the send grant,
 * checked from our own token row so the queue never holds a mail nobody could
 * send. Then the whole draft goes into mail_send_log as 'queued', and the
 * call is over: no token refresh, no ESI, nothing in anyone's inbox.
 */
export const enqueueMail = async (
  caller: Caller,
  registrationId: string,
  draft: MailDraft,
  source = 'mcp'
): Promise<EnqueueOutcome> => {
  const admitted = admit(caller, registrationId, draft)
  if ('error' in admitted) return admitted

  if (!(await sendGrantHeld(caller, registrationId))) {
    return failure(
      403,
      `${nameOf(admitted.registration)} has not granted permission to send mail. Turn on "Send in-game mail" under /settings/grants, then re-auth the character on /account/registrations.`
    )
  }

  const logId = await openLog(caller, admitted.registration, admitted.draft, source, 'queued')
  if (logId === 'taken') return conflict(admitted.draft.requestId, await spentRequest(caller, admitted.draft.requestId))

  return { ok: true, logId, requestId: admitted.draft.requestId }
}

/** The caller's mails still waiting to be sent, oldest first. */
export const listQueuedMail = async (caller: Caller): Promise<QueuedMail[]> => {
  const { data, error } = await caller.supabase
    .from('mail_send_log')
    .select('id, registration_id, request_id, recipients, subject, body, approved_cost, source, created_at')
    .eq('user_id', caller.userId)
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .returns<QueuedMail[]>()
  if (error) throw new Error(`mail_send_log read failed: ${error.message}`)
  return data ?? []
}

/**
 * Send one queued mail, by its mail_send_log id. The row is claimed by
 * flipping it queued → pending in one conditional update, so two people
 * sending the same queue at once cannot both deliver it: the second finds no
 * queued row and is told so. Then the ESI call, exactly as sendMail does it.
 */
export const sendQueuedMail = async (caller: Caller, logId: number): Promise<SendOutcome> => {
  const { data: claimed, error } = await caller.supabase
    .from('mail_send_log')
    .update({ status: 'pending' })
    .eq('id', logId)
    .eq('user_id', caller.userId)
    .eq('status', 'queued')
    .select('id, registration_id, request_id, recipients, subject, body, approved_cost, source, created_at')
    .maybeSingle<QueuedMail>()
  if (error) return failure(500, `Claiming queued mail ${logId} failed: ${error.message}`)
  if (!claimed) return failure(404, `No queued mail ${logId} on this account (already sent, or never queued).`)

  const admitted = admit(caller, claimed.registration_id, {
    requestId: claimed.request_id,
    recipients: claimed.recipients,
    subject: claimed.subject,
    body: claimed.body,
    approvedCost: Number(claimed.approved_cost),
  })
  if ('error' in admitted) {
    // Queued under rules that have since tightened, or a character that left
    // the account. The row is pending now, so close it rather than strand it.
    await closerOf(caller, logId).failed(admitted.error)
    return admitted
  }

  return deliver(caller, admitted.registration, admitted.draft, logId)
}
