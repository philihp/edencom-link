// `pnpm run mail-send` — send one EVE mail as a registered character, through
// the one send path (src/app/mail/lib.ts), and print the mail_send_log row it
// left. The owner's tool for proving the path end to end; nothing on the site
// calls it, and no test does.
//
//   pnpm run mail-send -- --registration <uuid> \
//     --to 90000001:character [--to 98000001:corporation …] \
//     --subject 'o7' --body 'fly safe' [--approved-cost 0]
//
// A real send: it reaches EVE. Runs on the service role (SUPABASE_URL +
// SUPABASE_SERVICE_KEY, plus the EVE_* SSO vars for the token refresh), like
// the other CLI utilities, and acts for whichever account owns the
// registration. Each run mints a fresh request id, so running it twice sends
// twice; the id is printed so a lost answer can be looked up in the log.
//
// TypeScript run by plain `node` (type stripping), so the CLI and a later MCP
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

const registrationId = values.registration ?? die(usage)
const specs = values.to ?? die(usage)
const recipients = specs.map((spec) => parseRecipient(spec) ?? die(`Cannot read recipient ${spec}. ${usage}`))
const approvedCost = values['approved-cost'] === undefined ? 0 : Number(values['approved-cost'])

const { data: found, error } = await sudoSupabase
  .from('registration')
  .select('id, user_id, character_id, name')
  .eq('id', registrationId)
  .not('character_id', 'is', null)
  .maybeSingle()
if (error) die(`Registration lookup failed: ${error.message}`)
const registration = found as { id: string; user_id: string; character_id: number | string; name: string | null } | null
if (!registration) {
  console.error(`No registration ${registrationId} with a character.`)
  process.exit(1)
}

const caller: Caller = {
  supabase: sudoSupabase,
  userId: registration.user_id,
  registrations: [
    {
      registration_id: registration.id,
      character_id: String(registration.character_id),
      name: registration.name,
    },
  ],
}

const requestId = randomUUID()
console.log(
  `request ${requestId}: ${registration.name ?? registration.character_id} → ${recipients.length} recipient(s)`
)

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

const { data: row } = await sudoSupabase.from('mail_send_log').select('*').eq('request_id', requestId).maybeSingle()
console.log(JSON.stringify(row ?? null, null, 2))

if ('error' in outcome)
  die(`${outcome.status} ${outcome.error}${outcome.detail ? ` ${JSON.stringify(outcome.detail)}` : ''}`)
else console.log(`sent: mail ${outcome.mailId} (log ${outcome.logId})`)
