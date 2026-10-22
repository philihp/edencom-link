// Unit coverage for the character-mail extract's pure seam
// (src/jobs/mailFields.js): mapping ESI's mail payloads onto character_mail and
// its siblings, and the rule for how far the header walk goes.
//
// What's worth pinning is what would be quietly wrong rather than loudly
// broken: a header upsert carrying body columns (and so wiping a fetched body
// on every sighting), recipients in ESI's order (so two sightings differ), the
// single-mail response's `read` being missed, and a walk that stops early (a
// gap) or never stops (a run that pages the whole mailbox every time).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  labelRow,
  MAIL_PAGE_SIZE,
  mailBodyPatch,
  mailHeaderRow,
  mailingListRow,
  nameableIds,
  normalizeRecipients,
  walkPlan,
} from '../src/jobs/mailFields.js'

const SEEN_AT = '2026-10-20T12:00:00.000Z'

const HEADER = {
  mail_id: 3001,
  from: 2112000001,
  subject: 'Re: hauling',
  timestamp: '2026-10-19T08:30:00Z',
  is_read: true,
  labels: [4, 1],
  recipients: [
    { recipient_id: 2112000003, recipient_type: 'character' },
    { recipient_id: 98000001, recipient_type: 'corporation' },
    { recipient_id: 2112000002, recipient_type: 'character' },
  ],
}

test('normalizeRecipients sorts by type then id and keeps only the two fields', () => {
  assert.deepEqual(
    normalizeRecipients([
      { recipient_id: '9', recipient_type: 'mailing_list', extra: 1 },
      { recipient_id: 5, recipient_type: 'character' },
      { recipient_id: 3, recipient_type: 'corporation' },
      { recipient_id: 2, recipient_type: 'character' },
    ]),
    [
      { recipient_id: 2, recipient_type: 'character' },
      { recipient_id: 5, recipient_type: 'character' },
      { recipient_id: 3, recipient_type: 'corporation' },
      { recipient_id: 9, recipient_type: 'mailing_list' },
    ]
  )
  assert.deepEqual(normalizeRecipients(undefined), [])
})

test('two sightings of one mail in different orders map to the same row', () => {
  const shuffled = { ...HEADER, labels: [1, 4], recipients: [...HEADER.recipients].reverse() }
  assert.deepEqual(mailHeaderRow(shuffled, SEEN_AT), mailHeaderRow(HEADER, SEEN_AT))
})

test('mailHeaderRow maps ESI names and never carries body columns', () => {
  const row = mailHeaderRow(HEADER, SEEN_AT)
  assert.deepEqual(row, {
    mail_id: 3001,
    from_id: 2112000001,
    subject: 'Re: hauling',
    sent_at: '2026-10-19T08:30:00Z',
    is_read: true,
    labels: [1, 4],
    recipients: [
      { recipient_id: 2112000002, recipient_type: 'character' },
      { recipient_id: 2112000003, recipient_type: 'character' },
      { recipient_id: 98000001, recipient_type: 'corporation' },
    ],
    last_seen_at: SEEN_AT,
  })
  // An upsert carrying these would reset a fetched body, or the first sighting.
  assert.equal('body' in row, false)
  assert.equal('body_fetched_at' in row, false)
  assert.equal('first_seen_at' in row, false)
})

test('mailHeaderRow defaults what ESI may omit', () => {
  const row = mailHeaderRow({ mail_id: 1, timestamp: '2026-01-01T00:00:00Z' }, SEEN_AT)
  assert.equal(row.from_id, 0)
  assert.equal(row.subject, null)
  assert.equal(row.is_read, false)
  assert.deepEqual(row.labels, [])
  assert.deepEqual(row.recipients, [])
})

test('mailBodyPatch keeps markup verbatim and reads the response `read`', () => {
  const body = '<font size="12">Fly safe</font><br><a href="showinfo:1377//2112000001">Pilot</a>'
  assert.deepEqual(mailBodyPatch({ body, read: false, labels: [2] }, SEEN_AT), {
    body,
    body_fetched_at: SEEN_AT,
    is_read: false,
    labels: [2],
  })
})

test('mailBodyPatch on a 404 stamps the fetch with a null body and touches nothing else', () => {
  assert.deepEqual(mailBodyPatch(null, SEEN_AT), { body: null, body_fetched_at: SEEN_AT })
})

test('mailBodyPatch leaves is_read/labels alone when the response omits them', () => {
  assert.deepEqual(mailBodyPatch({ body: 'hi' }, SEEN_AT), { body: 'hi', body_fetched_at: SEEN_AT })
})

test('labelRow and mailingListRow', () => {
  assert.deepEqual(labelRow({ label_id: 1, name: 'Inbox', color: '#ffffff', unread_count: 3 }), {
    label_id: 1,
    name: 'Inbox',
    color: '#ffffff',
    unread_count: 3,
  })
  assert.deepEqual(labelRow({ label_id: 256 }), { label_id: 256, name: null, color: null, unread_count: null })
  assert.deepEqual(mailingListRow({ mailing_list_id: '145000001', name: 'Industry' }), {
    mailing_list_id: 145000001,
    name: 'Industry',
  })
})

const fullPage = (top: number) => Array.from({ length: MAIL_PAGE_SIZE }, (_, i) => top - i)

test('walkPlan catchup carries on below a full page that brought something new', () => {
  const ids = fullPage(1000)
  const held = new Set(ids.slice(10))
  assert.deepEqual(walkPlan(ids, held), { next: 951, oldest: 951, exhausted: false })
})

test('walkPlan catchup stops at a full page of mail we already hold', () => {
  const ids = fullPage(1000)
  assert.deepEqual(walkPlan(ids, new Set(ids)), { next: null, oldest: 951, exhausted: false })
})

test('walkPlan backfill carries on regardless of what is held', () => {
  const ids = fullPage(500)
  assert.equal(walkPlan(ids, new Set(ids), { mode: 'backfill' }).next, 451)
})

test('walkPlan: a short or empty page is the bottom of the mailbox', () => {
  assert.deepEqual(walkPlan([30, 20, 10], new Set(), { mode: 'backfill' }), {
    next: null,
    oldest: 10,
    exhausted: true,
  })
  assert.deepEqual(walkPlan([], new Set(), { mode: 'backfill' }), { next: null, oldest: null, exhausted: true })
})

test('walkPlan takes the smallest id whatever order the page came in', () => {
  const ids = [...fullPage(1000)].reverse()
  assert.equal(walkPlan(ids, new Set(), { mode: 'backfill' }).oldest, 951)
})

test('nameableIds keeps senders and non-list recipients, deduplicated', () => {
  const rows = [
    mailHeaderRow(HEADER, SEEN_AT),
    mailHeaderRow(
      {
        mail_id: 2,
        from: 2112000001,
        timestamp: SEEN_AT,
        recipients: [{ recipient_id: 145000001, recipient_type: 'mailing_list' }],
      },
      SEEN_AT
    ),
    mailHeaderRow({ mail_id: 3, from: 145000002, timestamp: SEEN_AT }, SEEN_AT),
    mailHeaderRow({ mail_id: 4, timestamp: SEEN_AT }, SEEN_AT),
  ]
  assert.deepEqual(
    [...nameableIds(rows, new Set([145000002]))].sort((a, b) => a - b),
    [98000001, 2112000001, 2112000002, 2112000003]
  )
})
