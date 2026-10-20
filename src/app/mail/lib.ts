// Sending EVE mail as one of the caller's characters (docs/eve-mail.md "The
// send path"). Server-only: the second ESI write path after
// src/app/api/fittings/lib.ts, and built the same way — the whole draft goes
// into mail_send_log BEFORE ESI is called, under a caller-minted request id
// that is used once, so a client that lost a response can retry without the
// mail going out twice.
//
// Nothing on the site calls this yet. Its callers are `pnpm run mail-send`
// (src/mailSend.ts) and, later, the MCP `send_mail` tool. Both build a Caller
// the way the fittings routes do (callerForUser), on the service role, so
// every query below scopes itself to the caller's registrations by hand.
//
// Imports are relative with extensions, and the fittings types `import type`
// only, so the CLI can run this file under plain `node` (type stripping) as
// well as through the Next build. No `server-only` marker for the same reason:
// it throws outside the react-server condition, which a CLI never has.
import type { Caller, Failure, Registration } from '../api/fittings/lib.ts'

import { sendMail as esiSendMail } from '../../esi.js'
import { type MailDraft, type ValidDraft, validateDraft } from '../../mailCompose.ts'

export const SEND_SCOPE = 'esi-mail.send_mail.v1'

export type SendOutcome = { ok: true; mailId: number; logId: number } | Failure

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

// Open the mail_send_log row and hand back its closer. The insert is the
// point: the draft is on our side before CCP has it, so a crash after this
// leaves a 'pending' row saying exactly what may or may not have gone out.
const openLog = async (caller: Caller, registration: Registration, draft: ValidDraft, source: string) => {
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
      status: 'pending',
    })
    .select('id')
    .single<{ id: number }>()
  // 23505 = unique_violation on mail_send_log_request_id_idx: the index, not
  // any read before it, is what makes the id use-once under a race.
  if (error?.code === '23505') return 'taken' as const
  if (error || !data) throw new Error(`mail_send_log insert failed: ${error?.message ?? 'no row'}`)

  const close = async (patch: { status: 'ok'; mail_id: number } | { status: 'error'; error: string }) => {
    await caller.supabase
      .from('mail_send_log')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', data.id)
  }
  return {
    id: data.id,
    succeeded: (mailId: number) => close({ status: 'ok', mail_id: mailId }),
    failed: (message: string) => close({ status: 'error', error: message.slice(0, 1000) }),
  }
}

// ESI's CSPA refusal. Reported, never retried with a higher approved_cost:
// spending the player's ISK is a decision only the caller makes, explicitly.
const isCspaRefusal = (e: unknown) => (e as { status?: number })?.status === 520

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
  const registration = caller.registrations.find((r) => r.registration_id === registrationId)
  if (!registration) return failure(404, `No character ${registrationId} on this account.`)

  const verdict = validateDraft(draft)
  if (!verdict.ok) return failure(400, 'The draft cannot be sent.', { reasons: verdict.reasons })

  const log = await openLog(caller, registration, verdict.draft, source)
  if (log === 'taken') return conflict(verdict.draft.requestId, await spentRequest(caller, verdict.draft.requestId))

  const token = await sendToken(caller, registration)
  if ('error' in token) {
    await log.failed(token.error)
    return token
  }

  let mailId: number
  try {
    mailId = await esiSendMail(token.access_token, registration.character_id, {
      subject: verdict.draft.subject,
      body: verdict.draft.body,
      recipients: verdict.draft.recipients,
      approved_cost: verdict.draft.approvedCost,
    })
  } catch (e) {
    const message = (e as Error).message
    await log.failed(message)
    return isCspaRefusal(e)
      ? failure(
          402,
          `EVE refused the mail: a recipient's CSPA charge exceeds the approved ${verdict.draft.approvedCost} ISK. Nothing was retried; send again under a new request id with a higher approved cost if that is intended.`,
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
