// The mail replies dashboard's fold (src/app/indexes/mail/replies.ts): which
// received mail each of our replies answers, with no in-reply-to to go on.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  answered,
  countThreads,
  foldReceived,
  type MailRow,
  ourMails,
  type SendLogRow,
  threadReplies,
  threadSubject,
} from '../src/app/indexes/mail/replies.ts'

const ME = 9001
const ALT = 9002
const OWN = new Set([ME, ALT])
const STRANGER = 555

const mail = (over: Partial<MailRow>): MailRow => ({
  registration_id: 'reg-me',
  mail_id: 1,
  from_id: STRANGER,
  subject: 'Fuel',
  sent_at: '2026-11-10T10:00:00Z',
  is_read: false,
  recipients: [{ recipient_id: ME, recipient_type: 'character' }],
  body: 'Need fuel',
  ...over,
})

const log = (over: Partial<SendLogRow>): SendLogRow => ({
  id: 1,
  registration_id: 'reg-me',
  mail_id: null,
  subject: 'Re: Fuel',
  body: 'On its way',
  recipients: [{ recipient_id: STRANGER, recipient_type: 'character' }],
  status: 'queued',
  error: null,
  created_at: '2026-11-10T11:00:00Z',
  finished_at: null,
  ...over,
})

test('threadSubject strips every reply and forward prefix', () => {
  assert.equal(threadSubject('Re: RE:  Fw: Fuel  run'), 'fuel run')
  assert.equal(threadSubject('Fuel run'), 'fuel run')
  assert.equal(threadSubject(null), '')
})

test('foldReceived lists one entry per mail, holders from every alt, our own mail left out', () => {
  const rows = [
    mail({ registration_id: 'reg-me' }),
    mail({ registration_id: 'reg-alt', is_read: true, body: null }),
    mail({ mail_id: 2, from_id: ME, sent_at: '2026-11-11T00:00:00Z' }),
    mail({ mail_id: 3, sent_at: '2026-11-12T00:00:00Z', subject: 'Later' }),
  ]
  const received = foldReceived(rows, OWN)
  assert.deepEqual(
    received.map((r) => r.mailId),
    [3, 1]
  )
  assert.deepEqual(received[1].holders, ['reg-me', 'reg-alt'])
  assert.equal(received[1].isRead, true)
  assert.equal(received[1].body, 'Need fuel')
})

test('ourMails keeps the copy over the send log for one mail, and the outbox beside it', () => {
  const rows = [
    mail({ mail_id: 10, from_id: ME, subject: 'Re: Fuel', sent_at: '2026-11-10T12:00:00Z' }),
    // The same sent mail, copied into the alt's mailbox as its recipient.
    mail({ registration_id: 'reg-alt', mail_id: 10, from_id: ME, subject: 'Re: Fuel' }),
    mail({ mail_id: 11 }),
  ]
  const ours = ourMails(rows, [log({ id: 7, mail_id: 10, status: 'ok' }), log({ id: 8 })], OWN)
  assert.deepEqual(
    ours.map((r) => [r.key, r.status]),
    [
      ['mail:10', 'sent'],
      ['log:8', 'queued'],
    ]
  )
})

test('ourMails reads a sent log row the copy has not caught up with as sent, and a failure as error', () => {
  const ours = ourMails(
    [],
    [
      log({ mail_id: 12, status: 'ok', finished_at: '2026-11-10T11:05:00Z' }),
      log({ id: 2, status: 'error', error: '520' }),
    ],
    OWN
  )
  assert.deepEqual(
    ours.map((r) => [r.key, r.status, r.sentAt]),
    [
      ['mail:12', 'sent', '2026-11-10T11:05:00Z'],
      ['log:2', 'error', '2026-11-10T11:00:00Z'],
    ]
  )
})

test('a reply answers the mail it went back to, on the same subject, after it', () => {
  const received = foldReceived([mail({})], OWN)
  const [reply] = ourMails([], [log({})], OWN)
  assert.equal(answered(received, reply)?.mailId, 1)
})

test('a mail to someone else, on another subject, or sent before is no reply', () => {
  const received = foldReceived([mail({})], OWN)
  const other = (over: Partial<SendLogRow>) => ourMails([], [log(over)], OWN)[0]
  assert.equal(answered(received, other({ recipients: [{ recipient_id: 1, recipient_type: 'character' }] })), undefined)
  assert.equal(answered(received, other({ subject: 'Re: Ammo' })), undefined)
  assert.equal(answered(received, other({ created_at: '2026-11-10T09:00:00Z' })), undefined)
})

test('a reply-all naming the sender among others still answers', () => {
  const received = foldReceived([mail({})], OWN)
  const [reply] = ourMails(
    [],
    [
      log({
        recipients: [
          { recipient_id: 77, recipient_type: 'character' },
          { recipient_id: STRANGER, recipient_type: 'character' },
        ],
      }),
    ],
    OWN
  )
  assert.equal(answered(received, reply)?.mailId, 1)
})

test('a reply answers the newest matching mail before it, not a later one', () => {
  const received = foldReceived(
    [
      mail({ mail_id: 1, sent_at: '2026-11-10T08:00:00Z' }),
      mail({ mail_id: 2, sent_at: '2026-11-10T10:30:00Z' }),
      mail({ mail_id: 3, sent_at: '2026-11-10T12:00:00Z' }),
    ],
    OWN
  )
  const [reply] = ourMails([], [log({})], OWN)
  assert.equal(answered(received, reply)?.mailId, 2)
})

test('threadReplies pairs each mail with its replies, oldest reply first, and counts them', () => {
  const received = foldReceived(
    [mail({ mail_id: 1 }), mail({ mail_id: 2, subject: 'Ammo', sent_at: '2026-11-11T00:00:00Z' })],
    OWN
  )
  const replies = ourMails(
    [
      mail({
        mail_id: 20,
        from_id: ALT,
        subject: 'Re: Fuel',
        sent_at: '2026-11-10T13:00:00Z',
        recipients: [{ recipient_id: STRANGER, recipient_type: 'character' }],
      }),
    ],
    [log({ id: 5 }), log({ id: 6, subject: 'New topic' })],
    OWN
  )
  const threads = threadReplies(received, replies)
  assert.deepEqual(
    threads.map((t) => [t.received.mailId, t.replies.map((r) => r.key)]),
    [
      [2, []],
      [1, ['log:5', 'mail:20']],
    ]
  )
  assert.deepEqual(countThreads(threads), { received: 2, answered: 1, replies: 2 })
})
