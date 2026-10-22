// The pure mapping from ESI's mail payloads to the character-mail tables, and
// the rule for how far the header walk goes (docs/eve-mail.md). No I/O; tested
// in test/mailFields.test.ts.

import { any, ascend, chain, filter, map, pipe, prop, propEq, reduce, reject, sortWith, uniq } from 'ramda'

// ESI's page size for GET /characters/{id}/mail/. A shorter page is the bottom
// of the mailbox.
export const MAIL_PAGE_SIZE = 50

// A mail's recipients, reduced to the two fields ESI sends and sorted by
// (recipient_type, recipient_id), so two sightings of one mail compare equal
// whatever order ESI serialized them in.
export const normalizeRecipients = pipe(
  (recipients) => recipients ?? [],
  map((r) => ({ recipient_id: Number(r.recipient_id), recipient_type: String(r.recipient_type) })),
  sortWith([ascend(prop('recipient_type')), ascend(prop('recipient_id'))])
)

const normalizeLabels = (labels) => [...map(Number, labels ?? [])].sort((a, b) => a - b)

// One header's columns. The facts (sender, subject, time, recipients) are frozen
// at delivery; is_read and labels are the two fields a later sighting can
// change, and are overwritten every time. Neither body nor body_fetched_at is
// here, so re-upserting a header never clears a body already fetched, and
// first_seen_at is left to its column default so it marks the first sighting.
// ESI marks `from` optional; no EVE id is 0, so a missing sender reads as 0
// rather than failing the whole page on the not-null column.
export const mailHeaderRow = (header, seenAt) => ({
  mail_id: Number(header.mail_id),
  from_id: Number(header.from ?? 0),
  subject: header.subject ?? null,
  sent_at: header.timestamp,
  is_read: Boolean(header.is_read),
  labels: normalizeLabels(header.labels),
  recipients: normalizeRecipients(header.recipients),
  last_seen_at: seenAt,
})

// The update a fetched mail makes to its row. A tolerated 404 (`mail` null)
// stamps body_fetched_at with a null body, so a mail deleted between listing
// and fetch is never retried. A fetched mail also refreshes the two mutable
// fields, since the response carries them — as `read`, not the header's
// `is_read`. The body keeps EVE's markup verbatim.
export const mailBodyPatch = (mail, fetchedAt) => {
  if (mail == null) return { body: null, body_fetched_at: fetchedAt }
  const read = mail.read ?? mail.is_read
  return {
    body: mail.body ?? null,
    body_fetched_at: fetchedAt,
    ...(read != null ? { is_read: Boolean(read) } : {}),
    ...(mail.labels != null ? { labels: normalizeLabels(mail.labels) } : {}),
  }
}

export const labelRow = (label) => ({
  label_id: Number(label.label_id),
  name: label.name ?? null,
  color: label.color ?? null,
  unread_count: label.unread_count == null ? null : Number(label.unread_count),
})

export const mailingListRow = (list) => ({
  mailing_list_id: Number(list.mailing_list_id),
  name: list.name ?? null,
})

const minOf = reduce((lo, n) => (lo == null || n < lo ? n : lo), null)

// Whether the header walk fetches another page, and from which last_mail_id.
// `pageIds` are the ids the page just returned; `heldIds` the ones among them
// we already held before it (a Set). Two modes:
//
//   catchup  — walking down from the newest page to meet what we hold: carry
//              on while the page brought at least one mail we did not have.
//   backfill — walking down from the oldest mail we hold: carry on regardless.
//
// Either way a short page is the bottom of the mailbox (`exhausted`), which
// completes the backfill, and the next page starts below the page's smallest
// id. `oldest` is that smallest id (null for an empty page).
export const walkPlan = (pageIds, heldIds, { mode = 'catchup', pageSize = MAIL_PAGE_SIZE } = {}) => {
  const ids = map(Number, pageIds ?? [])
  const oldest = minOf(ids)
  const exhausted = ids.length < pageSize
  const brought = any((id) => !heldIds.has(id), ids)
  const more = !exhausted && (mode === 'backfill' || brought)
  return { next: more ? oldest : null, oldest, exhausted }
}

// The ids a page's headers name that universe/names can resolve: senders and
// recipients, minus mailing lists (by recipient_type, and by the ids of the
// character's own lists, since a sender can be a list too).
export const nameableIds = (rows, mailingListIds = new Set()) =>
  pipe(
    chain((row) => [
      row.from_id,
      ...pipe(reject(propEq('mailing_list', 'recipient_type')), map(prop('recipient_id')))(row.recipients ?? []),
    ]),
    uniq,
    filter((id) => Number.isFinite(id) && id > 0 && !mailingListIds.has(id))
  )(rows)
