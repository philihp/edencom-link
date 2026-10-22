// The outgoing-mail rules (docs/eve-mail.md "The send path"): a draft ESI
// would refuse is refused before anything is logged or sent.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_BODY_LENGTH,
  MAX_RECIPIENTS,
  MAX_SUBJECT_LENGTH,
  parseRecipient,
  validateDraft,
} from '../src/mailCompose.ts'

const draft = (overrides = {}) => ({
  requestId: '22222222-2222-4222-8222-222222222222',
  recipients: [{ recipient_id: 90000001, recipient_type: 'character' }],
  subject: 'o7',
  body: 'fly safe',
  ...overrides,
})

const reasonsOf = (input: Record<string, unknown>) => {
  const verdict = validateDraft(input)
  assert.equal(verdict.ok, false, 'expected the draft to be refused')
  return verdict.ok ? [] : verdict.reasons
}

test('a well-formed draft passes, with approvedCost defaulting to 0', () => {
  const verdict = validateDraft(draft())
  assert.deepEqual(verdict, {
    ok: true,
    draft: { ...draft(), approvedCost: 0 },
  })
})

test('an explicit approvedCost is kept', () => {
  const verdict = validateDraft(draft({ approvedCost: 5000 }))
  assert.equal(verdict.ok && verdict.draft.approvedCost, 5000)
})

test('every recipient type ESI knows is accepted', () => {
  const recipients = [
    { recipient_id: 1, recipient_type: 'character' },
    { recipient_id: 2, recipient_type: 'corporation' },
    { recipient_id: 3, recipient_type: 'alliance' },
    { recipient_id: 4, recipient_type: 'mailing_list' },
  ]
  assert.equal(validateDraft(draft({ recipients })).ok, true)
})

test('extra recipient fields are dropped rather than forwarded to ESI', () => {
  const verdict = validateDraft(draft({ recipients: [{ recipient_id: 7, recipient_type: 'alliance', name: 'x' }] }))
  assert.deepEqual(verdict.ok && verdict.draft.recipients, [{ recipient_id: 7, recipient_type: 'alliance' }])
})

test('recipient count is bounded at both ends', () => {
  assert.match(reasonsOf(draft({ recipients: [] })).join(), /at least one recipient/)
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({
    recipient_id: i + 1,
    recipient_type: 'character',
  }))
  assert.match(reasonsOf(draft({ recipients: many })).join(), /ESI allows 50/)
  assert.equal(validateDraft(draft({ recipients: many.slice(0, MAX_RECIPIENTS) })).ok, true)
  assert.match(reasonsOf(draft({ recipients: 'everyone' })).join(), /must be a list/)
})

test('a recipient needs a positive integer id and a known type', () => {
  const reasons = reasonsOf(
    draft({
      recipients: [
        { recipient_id: 0, recipient_type: 'character' },
        { recipient_id: 1.5, recipient_type: 'character' },
        { recipient_id: '90000001', recipient_type: 'character' },
        { recipient_id: 1, recipient_type: 'faction' },
        null,
      ],
    })
  )
  assert.deepEqual(
    reasons.map((r) => r.split(' ').slice(0, 2).join(' ')),
    ['recipient 1', 'recipient 2', 'recipient 3', 'recipient 4', 'recipient 5']
  )
  assert.match(reasons[3], /"faction"/)
})

test('subject and body must be non-empty and within ESI limits', () => {
  assert.match(reasonsOf(draft({ subject: '' })).join(), /subject is empty/)
  assert.match(reasonsOf(draft({ body: '' })).join(), /body is empty/)
  assert.match(reasonsOf(draft({ subject: 'x'.repeat(MAX_SUBJECT_LENGTH + 1) })).join(), /ESI allows 1000/)
  assert.match(reasonsOf(draft({ body: 'x'.repeat(MAX_BODY_LENGTH + 1) })).join(), /ESI allows 10000/)
  assert.match(reasonsOf(draft({ subject: undefined })).join(), /subject must be text/)
  assert.equal(
    validateDraft(draft({ subject: 'x'.repeat(MAX_SUBJECT_LENGTH), body: 'x'.repeat(MAX_BODY_LENGTH) })).ok,
    true
  )
})

test('approvedCost must be a non-negative integer', () => {
  assert.match(reasonsOf(draft({ approvedCost: -1 })).join(), /approvedCost/)
  assert.match(reasonsOf(draft({ approvedCost: 1.5 })).join(), /approvedCost/)
  assert.match(reasonsOf(draft({ approvedCost: '100' })).join(), /approvedCost/)
})

test('requestId must be a uuid', () => {
  assert.match(reasonsOf(draft({ requestId: 'abc' })).join(), /uuid/)
  assert.match(reasonsOf(draft({ requestId: undefined })).join(), /uuid/)
})

test('every reason is reported at once', () => {
  const reasons = reasonsOf({ requestId: 'no', recipients: [], subject: '', body: '', approvedCost: -5 })
  assert.equal(reasons.length, 5)
})

test('parseRecipient reads the CLI spelling <id>:<type>', () => {
  assert.deepEqual(parseRecipient('90000001:character'), { recipient_id: 90000001, recipient_type: 'character' })
  assert.deepEqual(parseRecipient(' 145:mailing_list '), { recipient_id: 145, recipient_type: 'mailing_list' })
  assert.equal(parseRecipient('90000001'), null)
  assert.equal(parseRecipient('0:character'), null)
  assert.equal(parseRecipient('1:faction'), null)
  assert.equal(parseRecipient('-1:character'), null)
})
