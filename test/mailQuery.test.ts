// The MCP mail tools' argument handling and shaping (src/app/api/mcp/
// mailQuery.ts): which of the caller's characters a call names, which label
// ids a label name means on each of them, which recipient a name or id means
// for a send, and how a mail's copies on several alts become one answer.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  byNewest,
  clampLimit,
  groupCopies,
  labelOrFilter,
  type MailRow,
  matchCharacters,
  MAX_LIMIT,
  type NameBook,
  parseBound,
  parseId,
  parseMailIds,
  pickCharacter,
  pickRecipient,
  recipientTypeOf,
  referencedIds,
  resolveLabel,
  shapeHeader,
  shapeMail,
} from '../src/app/api/mcp/mailQuery.ts'

const REG_A = '11111111-1111-4111-8111-111111111111'
const REG_B = '22222222-2222-4222-8222-222222222222'

const characters = [
  { registrationId: REG_A, characterId: '2112000001', name: 'Sir Cuddles' },
  { registrationId: REG_B, characterId: '2112000002', name: 'Cuddles Alt' },
]

// ── characters ────────────────────────────────────────────────────────────

test('no character query means every character', () => {
  assert.deepEqual(matchCharacters(undefined, characters), { ok: true, characters })
  assert.deepEqual(matchCharacters('  ', characters), { ok: true, characters })
})

test('a character is found by EVE id, then exact name, then substring', () => {
  assert.deepEqual(matchCharacters('2112000002', characters), { ok: true, characters: [characters[1]] })
  assert.deepEqual(matchCharacters('sir cuddles', characters), { ok: true, characters: [characters[0]] })
  assert.deepEqual(matchCharacters('cuddles', characters), { ok: true, characters })
})

test('a character query that names no one lists the characters there are', () => {
  const match = matchCharacters('Nobody', characters)
  assert.equal(match.ok, false)
  assert.match(match.ok ? '' : match.message, /Yours: Cuddles Alt, Sir Cuddles\./)
})

test('a send names exactly one character', () => {
  assert.deepEqual(pickCharacter('Sir Cuddles', characters), { ok: true, character: characters[0] })
  const several = pickCharacter('cuddles', characters)
  assert.equal(several.ok, false)
  assert.match(several.ok ? '' : several.message, /matches 2 of your characters/)
  assert.equal(pickCharacter('', characters).ok, false)
})

test('an exact name wins over a substring of another name', () => {
  const two = [
    { registrationId: REG_A, characterId: '1', name: 'Bob' },
    { registrationId: REG_B, characterId: '2', name: 'Bobby' },
  ]
  assert.deepEqual(pickCharacter('bob', two), { ok: true, character: two[0] })
})

// ── labels ────────────────────────────────────────────────────────────────

const labels = [
  { registrationId: REG_A, labelId: 1, name: 'Inbox' },
  { registrationId: REG_A, labelId: 16, name: 'Trade' },
  { registrationId: REG_B, labelId: 16, name: 'Personal' },
  { registrationId: REG_B, labelId: 17, name: 'Trade' },
]

test('the four fixed labels are the same id on every character, brackets optional', () => {
  assert.deepEqual(resolveLabel('inbox', labels, [REG_A, REG_B]), {
    ok: true,
    filter: { kind: 'every_character', labelId: 1, name: 'Inbox' },
  })
  assert.deepEqual(resolveLabel('[Corp]', labels, [REG_A]), {
    ok: true,
    filter: { kind: 'every_character', labelId: 4, name: '[Corp]' },
  })
  assert.deepEqual(resolveLabel('Alliance', [], [REG_A]), {
    ok: true,
    filter: { kind: 'every_character', labelId: 8, name: '[Alliance]' },
  })
})

test("a player's own label means its own id on each character", () => {
  assert.deepEqual(resolveLabel('trade', labels, [REG_A, REG_B]), {
    ok: true,
    filter: {
      kind: 'per_character',
      pairs: [
        { registrationId: REG_A, labelId: 16 },
        { registrationId: REG_B, labelId: 17 },
      ],
      name: 'Trade',
    },
  })
})

test('a label on a character out of scope does not count', () => {
  const filter = resolveLabel('personal', labels, [REG_A])
  assert.equal(filter.ok, false)
  assert.match(filter.ok ? '' : filter.message, /Labels: Inbox, Sent, \[Corp\], \[Alliance\], Trade\./)
})

test('a substring naming two labels is refused', () => {
  const two = [...labels, { registrationId: REG_A, labelId: 17, name: 'Trade alts' }]
  assert.deepEqual(resolveLabel('trade', two, [REG_A, REG_B]).ok, true, 'an exact name still wins')
  const filter = resolveLabel('tra', two, [REG_A, REG_B])
  assert.equal(filter.ok, false)
  assert.match(filter.ok ? '' : filter.message, /matches the labels Trade, Trade alts/)
})

test('a substring finds a fixed label through its row', () => {
  assert.deepEqual(resolveLabel('box', labels, [REG_A]), {
    ok: true,
    filter: { kind: 'per_character', pairs: [{ registrationId: REG_A, labelId: 1 }], name: 'Inbox' },
  })
})

test('a numeric label is that id on every character', () => {
  assert.deepEqual(resolveLabel('2', labels, [REG_A]), {
    ok: true,
    filter: { kind: 'every_character', labelId: 2, name: 'Sent' },
  })
})

test('per-character label pairs become one PostgREST or filter', () => {
  assert.equal(
    labelOrFilter([
      { registrationId: REG_A, labelId: 16 },
      { registrationId: REG_B, labelId: 17 },
    ]),
    `and(registration_id.eq.${REG_A},labels.cs.{16}),and(registration_id.eq.${REG_B},labels.cs.{17})`
  )
})

// ── bounds, ids, limits ───────────────────────────────────────────────────

test('time bounds pad partial dates and refuse nonsense', () => {
  assert.deepEqual(parseBound(undefined, 'since'), { ok: true, iso: null })
  assert.deepEqual(parseBound('2026-10', 'since'), { ok: true, iso: '2026-10-01T00:00:00.000Z' })
  assert.equal(parseBound('last tuesday', 'since').ok, false)
})

test('ids are positive whole numbers from numbers or digit strings', () => {
  assert.equal(parseId(98000001), 98000001)
  assert.equal(parseId(' 98000001 '), 98000001)
  assert.equal(parseId('0'), null)
  assert.equal(parseId('-4'), null)
  assert.equal(parseId('12a'), null)
  assert.equal(parseId(undefined), null)
})

test('mail ids are deduplicated and the bad ones reported', () => {
  assert.deepEqual(parseMailIds(['501', 501, 'x', '502']), { ids: [501, 502], bad: ['x'] })
})

test('the limit is clamped to 1..MAX_LIMIT', () => {
  assert.equal(clampLimit(undefined), 50)
  assert.equal(clampLimit(0), 1)
  assert.equal(clampLimit(10_000), MAX_LIMIT)
})

test('only characters, corporations and alliances are recipient types from universe_name', () => {
  assert.equal(recipientTypeOf('corporation'), 'corporation')
  assert.equal(recipientTypeOf('solar_system'), null)
  assert.equal(recipientTypeOf(null), null)
})

// ── recipients ────────────────────────────────────────────────────────────

test('an id with a type is sent as given, named when the directory knows it', () => {
  assert.deepEqual(pickRecipient({ id: '98000001', type: 'corporation' }, []), {
    ok: true,
    recipient: { recipient_id: 98000001, recipient_type: 'corporation' },
    name: null,
  })
  assert.deepEqual(
    pickRecipient({ id: 98000001, type: 'corporation' }, [{ id: 98000001, type: 'corporation', name: 'EDENCOM' }]),
    { ok: true, recipient: { recipient_id: 98000001, recipient_type: 'corporation' }, name: 'EDENCOM' }
  )
})

test('a name typed beside an id is not echoed back as if the site knew it', () => {
  assert.deepEqual(pickRecipient({ id: 2112000001, type: 'character', name: 'Someone Else' }, []), {
    ok: true,
    recipient: { recipient_id: 2112000001, recipient_type: 'character' },
    name: null,
  })
})

test('a name known once is that recipient', () => {
  assert.deepEqual(
    pickRecipient({ name: 'Sir Cuddles' }, [{ id: 2112000001, type: 'character', name: 'Sir Cuddles' }]),
    {
      ok: true,
      recipient: { recipient_id: 2112000001, recipient_type: 'character' },
      name: 'Sir Cuddles',
    }
  )
})

test('the same thing found in two directories is one candidate', () => {
  const pick = pickRecipient({ name: 'Sir Cuddles' }, [
    { id: 2112000001, type: 'character', name: null },
    { id: 2112000001, type: 'character', name: 'Sir Cuddles' },
  ])
  assert.deepEqual(pick, {
    ok: true,
    recipient: { recipient_id: 2112000001, recipient_type: 'character' },
    name: 'Sir Cuddles',
  })
})

test('a name that is two things is refused until a type picks one', () => {
  const both = [
    { id: 2112000009, type: 'character' as const, name: 'Goonswarm' },
    { id: 98000009, type: 'corporation' as const, name: 'Goonswarm' },
  ]
  const pick = pickRecipient({ name: 'Goonswarm' }, both)
  assert.equal(pick.ok, false)
  assert.match(
    pick.ok ? '' : pick.message,
    /could be Goonswarm \(character 2112000009\) or Goonswarm \(corporation 98000009\)/
  )
  assert.deepEqual(pickRecipient({ name: 'Goonswarm', type: 'corporation' }, both), {
    ok: true,
    recipient: { recipient_id: 98000009, recipient_type: 'corporation' },
    name: 'Goonswarm',
  })
})

test('an unknown name or an untyped unknown id is refused', () => {
  const name = pickRecipient({ name: 'Nobody' }, [])
  assert.equal(name.ok, false)
  assert.match(name.ok ? '' : name.message, /Pass its EVE id and type instead/)
  const id = pickRecipient({ id: 5 }, [])
  assert.equal(id.ok, false)
  assert.match(id.ok ? '' : id.message, /Add its type/)
})

test('an untyped id takes the type the directory knows it as', () => {
  assert.deepEqual(pickRecipient({ id: 145000001 }, [{ id: 145000001, type: 'mailing_list', name: 'Indy Chat' }]), {
    ok: true,
    recipient: { recipient_id: 145000001, recipient_type: 'mailing_list' },
    name: 'Indy Chat',
  })
})

test('a recipient with neither name nor id, or a bad id, is refused', () => {
  assert.equal(pickRecipient({}, []).ok, false)
  assert.equal(pickRecipient({ id: 'abc', type: 'character' }, []).ok, false)
})

// ── shaping ───────────────────────────────────────────────────────────────

const row = (overrides: Partial<MailRow> = {}): MailRow => ({
  registration_id: REG_A,
  mail_id: 501,
  from_id: 2112000009,
  subject: 'Fuel',
  sent_at: '2026-10-23T05:10:00+00:00',
  is_read: true,
  labels: [1, 4],
  recipients: [{ recipient_id: 98000001, recipient_type: 'corporation' }],
  body_fetched_at: '2026-10-24T05:26:00+00:00',
  ...overrides,
})

const book: NameBook = {
  names: new Map([
    [2112000009, 'Fuel Bot'],
    [98000001, 'EDENCOM'],
  ]),
  lists: new Map([[145000001, 'Indy Chat']]),
  characters: new Map([
    [REG_A, 'Sir Cuddles'],
    [REG_B, 'Cuddles Alt'],
  ]),
  labels: new Map([[`${REG_A}:16`, 'Trade']]),
}

test('referenced ids are the senders and recipients, once each', () => {
  assert.deepEqual(
    referencedIds([
      row(),
      row({ mail_id: 502, recipients: [{ recipient_id: 2112000009, recipient_type: 'character' }] }),
    ]),
    [2112000009, 98000001]
  )
})

test('copies of one mail on several characters group together, newest mail first', () => {
  const rows = byNewest([
    row({ mail_id: 400, sent_at: '2026-10-01T00:00:00+00:00' }),
    row(),
    row({ registration_id: REG_B, is_read: false }),
  ])
  const groups = groupCopies(rows)
  assert.deepEqual(
    groups.map((g) => g.map((c) => `${c.mail_id}@${c.registration_id === REG_A ? 'A' : 'B'}`)),
    [['501@A', '501@B'], ['400@A']]
  )
})

test('a header names its sender, recipients, characters and labels', () => {
  assert.deepEqual(shapeHeader([row(), row({ registration_id: REG_B, is_read: false, labels: [4] })], book), {
    mail_id: '501',
    sent_at: '2026-10-23T05:10:00+00:00',
    from: { id: '2112000009', name: 'Fuel Bot' },
    subject: 'Fuel',
    recipients: [{ id: '98000001', type: 'corporation', name: 'EDENCOM' }],
    characters: ['Sir Cuddles', 'Cuddles Alt'],
    is_read: false,
    labels: ['Inbox', '[Corp]'],
    body_copied: true,
  })
})

test('a mailing list resolves through the lists, an unknown id to null', () => {
  const header = shapeHeader(
    [
      row({
        from_id: 145000001,
        labels: [16, 99],
        recipients: [
          { recipient_id: 145000001, recipient_type: 'mailing_list' },
          { recipient_id: 7, recipient_type: 'character' },
        ],
        body_fetched_at: null,
      }),
    ],
    book
  )
  assert.deepEqual(header.from, { id: '145000001', name: 'Indy Chat' })
  assert.deepEqual(header.recipients, [
    { id: '145000001', type: 'mailing_list', name: 'Indy Chat' },
    { id: '7', type: 'character', name: null },
  ])
  assert.deepEqual(header.labels, ['Trade', 'label 99'])
  assert.equal(header.body_copied, false)
})

test('a read mail carries its body as plain text, or raw on request', () => {
  const copies = [row({ body: null, body_fetched_at: null }), row({ registration_id: REG_B, body: 'Low<br>fuel' })]
  const mail = shapeMail(copies, book)
  assert.equal(mail.body, 'Low\nfuel')
  assert.equal(mail.body_state, 'copied')
  assert.equal('body_copied' in mail, false)
  assert.equal(shapeMail(copies, book, { raw: true }).body, 'Low<br>fuel')
})

test('a body not yet fetched, or deleted before it was, says so', () => {
  const pending = shapeMail([row({ body: null, body_fetched_at: null })], book)
  assert.equal(pending.body_state, 'pending')
  assert.match(pending.note ?? '', /not copied yet/)
  const deleted = shapeMail([row({ body: null })], book)
  assert.equal(deleted.body_state, 'deleted')
  assert.match(deleted.note ?? '', /deleted in game/)
})
