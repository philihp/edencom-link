// The pure rules for an outgoing EVE mail (docs/eve-mail.md "The send path").
//
// Every send — the `mail-send` CLI today, the MCP `send_mail` tool later —
// passes a draft through validateDraft before anything is logged or sent, so
// a draft ESI would refuse is refused here instead, with every reason at once
// rather than ESI's first.
//
// The limits are ESI's, pinned from the live spec for
// `POST /characters/{character_id}/mail` (esi.evetech.net/meta/openapi.json,
// read 2026-10-20): recipients minItems 1 / maxItems 50, subject maxLength
// 1000, body maxLength 10000, approved_cost int64 default 0. If CCP moves
// them, move them here — nothing else in the tree restates them.
import { isNil } from 'ramda'

export const MIN_RECIPIENTS = 1
export const MAX_RECIPIENTS = 50
export const MAX_SUBJECT_LENGTH = 1000
export const MAX_BODY_LENGTH = 10000

export const RECIPIENT_TYPES = ['character', 'corporation', 'alliance', 'mailing_list'] as const
export type RecipientType = (typeof RECIPIENT_TYPES)[number]

export type Recipient = { recipient_id: number; recipient_type: RecipientType }

export type MailDraft = {
  /** Caller-minted, used once (mail_send_log.request_id). */
  requestId: string
  recipients: Recipient[]
  subject: string
  body: string
  /** ISK the caller agrees to pay in CSPA charges. Default 0. */
  approvedCost?: number
}

export type ValidDraft = Required<MailDraft>

export type DraftVerdict = { ok: true; draft: ValidDraft } | { ok: false; reasons: string[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isRecipientType = (value: unknown): value is RecipientType =>
  typeof value === 'string' && (RECIPIENT_TYPES as readonly string[]).includes(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const recipientReasons = (recipient: unknown, index: number): string[] => {
  if (typeof recipient !== 'object' || recipient === null) return [`recipient ${index + 1} is not an object`]
  const { recipient_id, recipient_type } = recipient as Record<string, unknown>
  return [
    ...(isPositiveInteger(recipient_id) ? [] : [`recipient ${index + 1} needs a positive integer recipient_id`]),
    ...(isRecipientType(recipient_type)
      ? []
      : [
          `recipient ${index + 1} has recipient_type ${JSON.stringify(recipient_type)}; expected one of ${RECIPIENT_TYPES.join(', ')}`,
        ]),
  ]
}

const textReasons = (field: string, value: unknown, max: number): string[] => {
  if (typeof value !== 'string') return [`${field} must be text`]
  if (value.length === 0) return [`${field} is empty`]
  if (value.length > max) return [`${field} is ${value.length} characters; ESI allows ${max}`]
  return []
}

/**
 * Every reason `draft` cannot be sent, or the draft with its defaults filled
 * in. Typed loosely on input because its callers hand it flags and JSON.
 */
export const validateDraft = (draft: Partial<Record<keyof MailDraft, unknown>>): DraftVerdict => {
  const { requestId, recipients, subject, body } = draft
  const approvedCost = isNil(draft.approvedCost) ? 0 : draft.approvedCost

  const recipientList = Array.isArray(recipients) ? recipients : null
  const reasons = [
    ...(typeof requestId === 'string' && UUID.test(requestId) ? [] : ['requestId must be a uuid']),
    ...(recipientList === null
      ? ['recipients must be a list']
      : recipientList.length < MIN_RECIPIENTS
        ? ['a mail needs at least one recipient']
        : recipientList.length > MAX_RECIPIENTS
          ? [`${recipientList.length} recipients; ESI allows ${MAX_RECIPIENTS}`]
          : recipientList.flatMap(recipientReasons)),
    ...textReasons('subject', subject, MAX_SUBJECT_LENGTH),
    ...textReasons('body', body, MAX_BODY_LENGTH),
    ...(typeof approvedCost === 'number' && Number.isSafeInteger(approvedCost) && approvedCost >= 0
      ? []
      : ['approvedCost must be a non-negative integer']),
  ]

  if (reasons.length > 0) return { ok: false, reasons }
  return {
    ok: true,
    draft: {
      requestId: requestId as string,
      recipients: (recipientList as Recipient[]).map(({ recipient_id, recipient_type }) => ({
        recipient_id,
        recipient_type,
      })),
      subject: subject as string,
      body: body as string,
      approvedCost: approvedCost as number,
    },
  }
}

/** `<id>:<type>`, the CLI's recipient spelling. Null when it doesn't parse. */
export const parseRecipient = (spec: string): Recipient | null => {
  const match = /^(\d+):([a-z_]+)$/.exec(spec.trim())
  if (!match) return null
  const recipient_id = Number(match[1])
  return isPositiveInteger(recipient_id) && isRecipientType(match[2])
    ? { recipient_id, recipient_type: match[2] }
    : null
}
