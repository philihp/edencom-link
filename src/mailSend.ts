// `pnpm run mail-send` — the owner's end-to-end check of the EVE mail send
// path (docs/eve-mail.md "The send path"):
//
//   pnpm run mail-send -- --registration <uuid> \
//     --to 90000001:character [--to 98000001:corporation …] \
//     --subject 'o7' --body 'fly safe' [--approved-cost 0]
//       Send a fresh draft at once, through the same sendMail the
//       mail-queue-send cron uses. A REAL SEND: it reaches EVE. Each run
//       mints a fresh request id, so running it twice sends twice; the id is
//       printed so a lost answer can be looked up in the log.
//
// Runs on the service role (SUPABASE_URL + SUPABASE_SERVICE_KEY, plus the
// EVE_* SSO vars for the token refresh), like the other CLI utilities, and
// acts for whichever account owns the registration. Nothing on the site calls
// it, no test does, and no job runs it. Mail from MCP send_mail does not need
// it: the mail-queue-send cron sends that (src/app/mail/sendQueue.ts).
//
// TypeScript run by plain `node` (type stripping), so the CLI and the MCP
// tool share the lib rather than each carrying an ESI write.
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

import type { Caller } from './app/api/fittings/lib.ts'

import { sendMail } from './app/mail/lib.ts'
import { parseRecipient, type Recipient } from './mailCompose.ts'
import { sudoSupabase } from './supabase.js'

const usage =
  'usage: pnpm run mail-send -- --registration <uuid> --to <id>:<character|corporation|alliance|mailing_list> [--to …] --subject <text> --body <text> [--approved-cost <isk>]'

const die = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const { values } = parseArgs({
  options: {
    registration: { type: 'string' },
    to: { type: 'string', multiple: true },
    subject: { type: 'string' },
    body: { type: 'string' },
    'approved-cost': { type: 'string' },
  },
  strict: true,
})

type RegistrationRow = { id: string; user_id: string; character_id: number | string; name: string | null }

// A Caller for the account owning `registrationId`, carrying every character
// of that account, as callerForUser builds one; sendMail checks the character
// is the caller's.
const callerOwning = async (registrationId: string): Promise<Caller> => {
  const { data: found, error } = await sudoSupabase
    .from('registration')
    .select('id, user_id, character_id, name')
    .eq('id', registrationId)
    .not('character_id', 'is', null)
    .maybeSingle<RegistrationRow>()
  if (error) die(`Registration lookup failed: ${error.message}`)
  if (!found) die(`No registration ${registrationId} with a character.`)
  const owner = found as RegistrationRow

  const { data: siblings, error: siblingsError } = await sudoSupabase
    .from('registration')
    .select('id, user_id, character_id, name')
    .eq('user_id', owner.user_id)
    .not('character_id', 'is', null)
    .returns<RegistrationRow[]>()
  if (siblingsError) die(`Registration lookup failed: ${siblingsError.message}`)

  return {
    supabase: sudoSupabase,
    userId: owner.user_id,
    registrations: (siblings ?? [owner]).map((r) => ({
      registration_id: r.id,
      character_id: String(r.character_id),
      name: r.name,
    })),
  }
}

const printRow = async (requestId: string) => {
  const { data: row } = await sudoSupabase.from('mail_send_log').select('*').eq('request_id', requestId).maybeSingle()
  console.log(JSON.stringify(row ?? null, null, 2))
}

const report = (outcome: Awaited<ReturnType<typeof sendMail>>) => {
  if ('error' in outcome)
    die(`${outcome.status} ${outcome.error}${outcome.detail ? ` ${JSON.stringify(outcome.detail)}` : ''}`)
  else console.log(`sent: mail ${outcome.mailId} (log ${outcome.logId})`)
}

// ── a fresh draft ──────────────────────────────────────────────────────────
const registrationId = values.registration ?? die(usage)
const specs = values.to ?? die(usage)
const recipients = specs.map((spec) => parseRecipient(spec) ?? die(`Cannot read recipient ${spec}. ${usage}`))
const approvedCost = values['approved-cost'] === undefined ? 0 : Number(values['approved-cost'])

const caller = await callerOwning(registrationId)
const sender = caller.registrations.find((r) => r.registration_id === registrationId)

const requestId = randomUUID()
console.log(`request ${requestId}: ${sender?.name ?? sender?.character_id} → ${recipients.length} recipient(s)`)

const outcome = await sendMail(
  caller,
  registrationId,
  {
    requestId,
    recipients: recipients as Recipient[],
    subject: values.subject ?? '',
    body: values.body ?? '',
    approvedCost,
  },
  'cli'
)

await printRow(requestId)
report(outcome)
