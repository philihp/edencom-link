// The mail replies dashboard's fold (/indexes/mail): which received mail each
// of our replies answers. Pure, no I/O — the page reads character_mail and
// mail_send_log and hands the rows here (test/mailReplies.test.ts).
//
// EVE mail carries no in-reply-to link: ESI's header has a sender, the
// recipients, a subject and a time, and nothing more. So a reply is found the
// way a player finds one in the client. A mail of ours answers a received
// mail when
//
//   - it went to the received mail's sender (any recipient on it, since a
//     reply-all names the sender first and everyone else after),
//   - its subject is the received subject once the "Re:"/"Fw:" prefixes are
//     taken off both, and
//   - it was sent after the received mail.
//
// When several received mails pass all three (one sender writing the same
// subject twice), the reply answers the newest one before it, which is the one
// the client's Reply button would have been pressed on.
//
// Our side comes from two places. character_mail holds every mail the extract
// copied, our own sent ones too (from_id is one of our characters).
// mail_send_log holds what this site sent or has in the outbox, which the
// extract has not copied yet, or never will (queued, failed). A log row whose
// mail_id the copy already holds is the same mail and is dropped.
import { ascend, descend, filter, groupBy, head, map, pipe, prop, reduce, sortWith, sum, uniqBy, values } from 'ramda'

export type RecipientRow = { recipient_id: number | string; recipient_type: string }

export type MailRow = {
  registration_id: string
  mail_id: number | string
  from_id: number | string
  subject: string | null
  sent_at: string
  is_read?: boolean | null
  recipients: RecipientRow[] | null
  body?: string | null
}

export type SendLogRow = {
  id: number | string
  registration_id: string
  mail_id: number | string | null
  subject: string
  body: string
  recipients: RecipientRow[] | null
  status: string
  error: string | null
  created_at: string
  finished_at: string | null
}

export type Recipient = { id: number; type: string }

export type Received = {
  mailId: number
  fromId: number
  subject: string
  sentAt: string
  // Our registrations holding a copy: a corporation mail reaches every alt in it.
  holders: string[]
  isRead: boolean
  recipients: Recipient[]
  body: string | null
}

// 'sent' is in the copy or answered by ESI; the rest are mail_send_log's states.
export type ReplyStatus = 'sent' | 'queued' | 'pending' | 'error'

export type Reply = {
  key: string
  mailId: number | null
  registrationId: string
  subject: string
  sentAt: string
  recipients: Recipient[]
  body: string | null
  status: ReplyStatus
  error: string | null
}

export type Thread = { received: Received; replies: Reply[] }

const PREFIX = /^\s*(re|fw|fwd)\s*:\s*/i

/** A subject with every leading "Re:"/"Fw:" taken off, case and spacing folded. */
export const threadSubject = (subject: string | null | undefined): string => {
  const strip = (s: string): string => (PREFIX.test(s) ? strip(s.replace(PREFIX, '')) : s)
  return strip(subject ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const toRecipients: (rows: RecipientRow[] | null) => Recipient[] = (rows) =>
  map((r: RecipientRow) => ({ id: Number(r.recipient_id), type: r.recipient_type }), rows ?? [])

const time = (iso: string): number => new Date(iso).getTime()

const isOurs =
  (ownCharacterIds: ReadonlySet<number>) =>
  (row: MailRow): boolean =>
    ownCharacterIds.has(Number(row.from_id))

/**
 * Mails our characters received, one entry per mail however many of our
 * characters hold a copy, newest first. A mail one of our characters sent is
 * never "received", even where an alt of ours got it.
 */
export const foldReceived = (rows: MailRow[], ownCharacterIds: ReadonlySet<number>): Received[] =>
  pipe(
    filter((row: MailRow) => !isOurs(ownCharacterIds)(row)),
    groupBy((row: MailRow) => String(row.mail_id)),
    values,
    map((copies: MailRow[] | undefined): Received => {
      const all = copies ?? []
      const first = all[0]
      return {
        mailId: Number(first.mail_id),
        fromId: Number(first.from_id),
        subject: first.subject ?? '',
        sentAt: first.sent_at,
        holders: map((c: MailRow) => c.registration_id, all),
        isRead: all.some((c) => c.is_read === true),
        recipients: toRecipients(first.recipients),
        body: all.find((c) => c.body != null)?.body ?? null,
      }
    }),
    sortWith([descend((r: Received) => time(r.sentAt)), descend((r: Received) => r.mailId)])
  )(rows)

const fromCopy = (row: MailRow): Reply => ({
  key: `mail:${row.mail_id}`,
  mailId: Number(row.mail_id),
  registrationId: row.registration_id,
  subject: row.subject ?? '',
  sentAt: row.sent_at,
  recipients: toRecipients(row.recipients),
  body: row.body ?? null,
  status: 'sent',
  error: null,
})

const logStatus = (status: string): ReplyStatus =>
  status === 'ok' ? 'sent' : status === 'queued' || status === 'pending' ? status : 'error'

const fromLog = (row: SendLogRow): Reply => ({
  key: row.mail_id != null ? `mail:${row.mail_id}` : `log:${row.id}`,
  mailId: row.mail_id != null ? Number(row.mail_id) : null,
  registrationId: row.registration_id,
  subject: row.subject,
  sentAt: row.finished_at ?? row.created_at,
  recipients: toRecipients(row.recipients),
  body: row.body,
  status: logStatus(row.status),
  error: row.error,
})

/**
 * Every mail we sent or have in the outbox, once each: the copy wins over the
 * send log for a mail both hold (the copy carries EVE's own send time), and a
 * mail sent to an alt of ours is held by both alts but listed once.
 */
export const ourMails = (rows: MailRow[], log: SendLogRow[], ownCharacterIds: ReadonlySet<number>): Reply[] =>
  uniqBy(prop('key'), [...map(fromCopy, filter(isOurs(ownCharacterIds), rows)), ...map(fromLog, log)])

/** Does this mail of ours answer that received one (see the head of the file)? */
export const answers =
  (reply: Reply) =>
  (received: Received): boolean =>
    reply.recipients.some((r) => r.id === received.fromId) &&
    threadSubject(reply.subject) === threadSubject(received.subject) &&
    time(reply.sentAt) > time(received.sentAt)

/** The received mail a reply answers: the newest that matches, or none. */
export const answered = (received: Received[], reply: Reply): Received | undefined =>
  pipe(filter(answers(reply)), sortWith([descend((r: Received) => time(r.sentAt))]), head<Received>)(received)

/**
 * Each received mail with the replies we sent to it, oldest reply first; the
 * mails stay newest first. A mail of ours that answers nothing here (a new
 * mail, or a reply to something older than the window) is left out.
 */
export const threadReplies = (received: Received[], replies: Reply[]): Thread[] => {
  const byMail = reduce(
    (acc: Map<number, Reply[]>, reply: Reply) => {
      const target = answered(received, reply)
      return target ? acc.set(target.mailId, [...(acc.get(target.mailId) ?? []), reply]) : acc
    },
    new Map<number, Reply[]>(),
    replies
  )
  return map(
    (r: Received): Thread => ({
      received: r,
      replies: sortWith([ascend((x: Reply) => time(x.sentAt))], byMail.get(r.mailId) ?? []),
    }),
    received
  )
}

export type ThreadCounts = { received: number; answered: number; replies: number }

const replyCount = (t: Thread): number => t.replies.length

export const countThreads = (threads: Thread[]): ThreadCounts => ({
  received: threads.length,
  answered: filter((t: Thread) => replyCount(t) > 0, threads).length,
  replies: sum(map(replyCount, threads)),
})
