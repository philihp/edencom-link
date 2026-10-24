// Argument handling and shaping for the MCP mail tools (mailTools.ts,
// docs/eve-mail.md PR 4). Like the other *Query.ts seams this module does no
// I/O: the tools read character_mail and the name directories, and hand the
// rows here — so which character, label and recipient a call names, and what
// a mail looks like in the answer, are unit-testable (test/mailQuery.test.ts).
import { all, any, ascend, chain, filter, map, pipe, sortBy, sortWith, uniq, uniqBy } from 'ramda'

import type { Recipient, RecipientType } from '../../../mailCompose.ts'
import { mailText } from '../../../mailText.ts'
import { parseAtParam } from '../../../utils/atParam.ts'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
// read_mail's cap: twenty whole bodies is a thread, and already a long answer.
export const MAX_READ = 20
// A `from` filter that resolves to more senders than this is too broad a
// substring to be a sender, and would bloat the `.in()` list.
export const MAX_SENDER_IDS = 100

export const clampLimit = (limit: number | undefined): number =>
  Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)

type Refusal = { ok: false; message: string }
const refuse = (message: string): Refusal => ({ ok: false, message })

// ── The caller's own characters ───────────────────────────────────────────

export type OwnCharacter = { registrationId: string; characterId: string; name: string }

export type CharacterMatch = { ok: true; characters: OwnCharacter[] } | Refusal

const namesOf = (characters: OwnCharacter[]) =>
  pipe(
    map((c: OwnCharacter) => c.name),
    sortWith([ascend((n: string) => n.toLowerCase())])
  )(characters).join(', ')

/**
 * Every one of the caller's characters a query names: by EVE character id,
 * else by exact name (case-insensitive), else by name substring. No query
 * means all of them. A mail tool only ever reads or sends as these — a
 * character shared in from someone else is never one of them.
 */
export const matchCharacters = (query: string | undefined, characters: OwnCharacter[]): CharacterMatch => {
  const q = (query ?? '').trim()
  if (q === '') return { ok: true, characters }
  const lower = q.toLowerCase()
  const byId = filter((c: OwnCharacter) => c.characterId === q, characters)
  const exact = filter((c: OwnCharacter) => c.name.toLowerCase() === lower, characters)
  const partial = filter((c: OwnCharacter) => c.name.toLowerCase().includes(lower), characters)
  const hits = byId.length > 0 ? byId : exact.length > 0 ? exact : partial
  if (hits.length > 0) return { ok: true, characters: hits }
  return refuse(
    characters.length === 0
      ? 'This account has no characters.'
      : `None of your characters is named "${q}". Yours: ${namesOf(characters)}.`
  )
}

/** The one character a send goes out as: a query that names several is refused. */
export const pickCharacter = (
  query: string,
  characters: OwnCharacter[]
): { ok: true; character: OwnCharacter } | Refusal => {
  if (query.trim() === '') return refuse(`Name the character to send as. Yours: ${namesOf(characters)}.`)
  const match = matchCharacters(query, characters)
  if (!match.ok) return match
  if (match.characters.length > 1) {
    return refuse(
      `"${query.trim()}" matches ${match.characters.length} of your characters: ${namesOf(match.characters)}. Name one exactly.`
    )
  }
  return { ok: true, character: match.characters[0] }
}

// ── Labels ────────────────────────────────────────────────────────────────

export type LabelRow = { registrationId: string; labelId: number; name: string | null }

// ESI's four fixed labels carry the same id on every character; a player's own
// labels are numbered per character (from 16 up), so the same name can be a
// different id on each alt.
const STANDARD_LABEL_IDS: Record<string, number> = { inbox: 1, sent: 2, corp: 4, corporation: 4, alliance: 8 }
const STANDARD_LABEL_NAMES: Record<number, string> = { 1: 'Inbox', 2: 'Sent', 4: '[Corp]', 8: '[Alliance]' }

const normalizeLabel = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .trim()

export type LabelFilter =
  | { ok: true; filter: null }
  | { ok: true; filter: { kind: 'every_character'; labelId: number; name: string } }
  | {
      ok: true
      filter: { kind: 'per_character'; pairs: Array<{ registrationId: string; labelId: number }>; name: string }
    }
  | Refusal

/**
 * The label a list_mail call names, as the label ids it means on each of the
 * characters in scope. Inbox, Sent, Corp and Alliance (brackets optional) are
 * the fixed ids; anything else matches the characters' own labels by exact
 * name, else by a substring that names one label.
 */
export const resolveLabel = (query: string | undefined, labels: LabelRow[], registrationIds: string[]): LabelFilter => {
  const raw = (query ?? '').trim()
  if (raw === '') return { ok: true, filter: null }
  if (/^\d+$/.test(raw)) {
    const labelId = Number(raw)
    return {
      ok: true,
      filter: { kind: 'every_character', labelId, name: STANDARD_LABEL_NAMES[labelId] ?? `label ${raw}` },
    }
  }
  const q = normalizeLabel(raw)
  const standard = STANDARD_LABEL_IDS[q]
  if (standard != null) {
    return { ok: true, filter: { kind: 'every_character', labelId: standard, name: STANDARD_LABEL_NAMES[standard] } }
  }

  // Every label row of the characters in scope, the fixed four included, so a
  // substring such as "box" still finds Inbox.
  const own = filter((l: LabelRow) => l.name != null && registrationIds.includes(l.registrationId), labels)
  const exact = filter((l: LabelRow) => normalizeLabel(l.name as string) === q, own)
  const hits = exact.length > 0 ? exact : filter((l: LabelRow) => normalizeLabel(l.name as string).includes(q), own)
  const hitNames = uniq(map((l: LabelRow) => normalizeLabel(l.name as string), hits))
  if (hits.length === 0) {
    const available = uniq([
      ...Object.values(STANDARD_LABEL_NAMES),
      ...sortBy((n: string) => n.toLowerCase(), uniq(map((l: LabelRow) => l.name as string, own))),
    ])
    return refuse(`No mail label is named "${raw}". Labels: ${available.join(', ')}.`)
  }
  if (hitNames.length > 1) {
    return refuse(
      `"${raw}" matches the labels ${uniq(map((l: LabelRow) => l.name as string, hits)).join(', ')}. Name one exactly.`
    )
  }
  return {
    ok: true,
    filter: {
      kind: 'per_character',
      pairs: map((l: LabelRow) => ({ registrationId: l.registrationId, labelId: l.labelId }), hits),
      name: hits[0].name as string,
    },
  }
}

/**
 * A per-character label as one PostgREST `or` filter: a mail matches when it
 * belongs to one of the characters and carries that character's label id.
 * Every value is a registration uuid or an integer from our own rows, so
 * nothing needs quoting.
 */
export const labelOrFilter = (pairs: Array<{ registrationId: string; labelId: number }>): string =>
  map(({ registrationId, labelId }) => `and(registration_id.eq.${registrationId},labels.cs.{${labelId}})`, pairs).join(
    ','
  )

// ── Times ─────────────────────────────────────────────────────────────────

/** An optional `since`/`until` bound as an ISO timestamp; partial dates pad out (2026-10 → 2026-10-01). */
export const parseBound = (raw: string | undefined, label: string): { ok: true; iso: string | null } | Refusal => {
  const trimmed = raw?.trim()
  if (!trimmed) return { ok: true, iso: null }
  const parsed = parseAtParam(trimmed)
  return parsed.ok
    ? { ok: true, iso: parsed.iso }
    : refuse(`${label} must be an ISO 8601 date or time, e.g. 2026-10-01.`)
}

// ── Ids ───────────────────────────────────────────────────────────────────

/** A positive whole id from a number or a digit string; null when it is not one. */
export const parseId = (value: string | number | undefined | null): number | null => {
  if (value == null) return null
  const text = typeof value === 'number' ? String(value) : value.trim()
  if (!/^\d+$/.test(text)) return null
  const id = Number(text)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** universe_name's category, when it is a kind of thing a mail can be sent to. */
export const recipientTypeOf = (category: string | null | undefined): RecipientType | null =>
  category === 'character' || category === 'corporation' || category === 'alliance' ? category : null

// ── Recipients of a send ──────────────────────────────────────────────────

export type RecipientSpec = { name?: string; id?: string | number; type?: RecipientType }

/** Something the site's directories know a name or an id as. */
export type Candidate = { id: number; type: RecipientType; name: string | null }

export type RecipientPick = { ok: true; recipient: Recipient; name: string | null } | Refusal

const describeCandidate = (c: Candidate) => `${c.name ?? '(no name)'} (${c.type} ${c.id})`

/**
 * The one recipient a spec means. `candidates` are what the directories hold
 * for the spec's name (exact, case-insensitive) or, for an id with no type,
 * for that id. An id with a type needs no directory: it is sent as given. A
 * name that is two things (a pilot and a corporation can share one) is
 * refused rather than guessed.
 */
export const pickRecipient = (spec: RecipientSpec, candidates: Candidate[]): RecipientPick => {
  const name = (spec.name ?? '').trim()
  const id = parseId(spec.id)
  if (spec.id != null && id == null)
    return refuse(`Recipient id ${JSON.stringify(spec.id)} is not a positive whole number.`)
  if (id == null && name === '') return refuse('Each recipient needs a name or an id.')

  const typed = spec.type ? filter((c: Candidate) => c.type === spec.type, candidates) : candidates
  const known = uniqBy(
    (c: Candidate) => `${c.type}:${c.id}`,
    sortBy(
      (c: Candidate) => (c.name == null ? 1 : 0),
      id == null ? typed : filter((c: Candidate) => c.id === id, typed)
    )
  )

  if (id != null && spec.type) {
    return {
      ok: true,
      recipient: { recipient_id: id, recipient_type: spec.type },
      // Only a name the directory confirms: a name typed beside the id is not
      // proof the id is that pilot, and the preview must not say it is.
      name: known[0]?.name ?? null,
    }
  }
  if (known.length === 0) {
    return refuse(
      id != null
        ? `This site does not know what id ${id} is. Add its type: character, corporation, alliance or mailing_list.`
        : `No ${spec.type ? spec.type.replace('_', ' ') : 'character, corporation, alliance or mailing list'} named "${name}" is known to this site. Pass its EVE id and type instead.`
    )
  }
  if (known.length > 1) {
    return refuse(
      `"${name || id}" could be ${map(describeCandidate, known).join(' or ')}. Add the type, or pass the id.`
    )
  }
  return {
    ok: true,
    recipient: { recipient_id: known[0].id, recipient_type: known[0].type },
    name: known[0].name,
  }
}

// ── Mails as the tools answer them ────────────────────────────────────────

export type MailRow = {
  registration_id: string
  mail_id: number | string
  from_id: number | string
  subject: string | null
  sent_at: string
  is_read: boolean
  labels: Array<number | string> | null
  recipients: Array<{ recipient_id: number | string; recipient_type: string }> | null
  body_fetched_at: string | null
  body?: string | null
}

/** What the tools know the ids in a page of mail by. */
export type NameBook = {
  /** Characters, corporations and alliances, by EVE id. */
  names: Map<number, string>
  /** The caller's mailing lists, by list id. */
  lists: Map<number, string>
  /** The caller's characters, by registration uuid. */
  characters: Map<string, string>
  /** Label names, by `${registration uuid}:${label id}`. */
  labels: Map<string, string>
}

/** Every id a page of mail names, as sender or recipient, for one directory read. */
export const referencedIds = (rows: MailRow[]): number[] =>
  uniq(
    chain((row: MailRow) => [Number(row.from_id), ...map((r) => Number(r.recipient_id), row.recipients ?? [])], rows)
  ).filter((id) => Number.isSafeInteger(id) && id > 0)

// A sender has no type in ESI's header, so a mailing list (a sender can be
// one) is looked for first, then everything universe/names resolves.
const senderName = (id: number, book: NameBook): string | null => book.lists.get(id) ?? book.names.get(id) ?? null

const recipientName = (id: number, type: string, book: NameBook): string | null =>
  (type === 'mailing_list' ? book.lists.get(id) : book.names.get(id)) ?? null

const labelName = (registrationId: string, labelId: number, book: NameBook): string =>
  book.labels.get(`${registrationId}:${labelId}`) ?? STANDARD_LABEL_NAMES[labelId] ?? `label ${labelId}`

/**
 * One mail's copies grouped together, in the order the rows came (newest
 * first). A mail to a corporation, an alliance or a mailing list reaches every
 * registered member, and each character holds its own copy under one mail id.
 */
export const groupCopies = (rows: MailRow[]): MailRow[][] => {
  const order: string[] = []
  const groups = new Map<string, MailRow[]>()
  rows.forEach((row) => {
    const key = String(row.mail_id)
    const group = groups.get(key)
    if (group) group.push(row)
    else {
      order.push(key)
      groups.set(key, [row])
    }
  })
  return map((key) => groups.get(key) as MailRow[], order)
}

export type BodyState = 'copied' | 'pending' | 'deleted'

// `pending`: the extract has not fetched it yet. `deleted`: ESI answered 404
// when it tried, because the mail was deleted in game before it was copied.
const bodyState = (copies: MailRow[]): BodyState =>
  any((c: MailRow) => c.body != null, copies)
    ? 'copied'
    : any((c: MailRow) => c.body_fetched_at != null, copies)
      ? 'deleted'
      : 'pending'

/** A mail's header as list_mail answers it, from all of its copies. */
export const shapeHeader = (copies: MailRow[], book: NameBook) => {
  const [first] = copies
  const fromId = Number(first.from_id)
  return {
    mail_id: String(first.mail_id),
    sent_at: first.sent_at,
    from: { id: String(fromId), name: senderName(fromId, book) },
    subject: first.subject,
    recipients: map(
      (r) => ({
        id: String(r.recipient_id),
        type: r.recipient_type,
        name: recipientName(Number(r.recipient_id), r.recipient_type, book),
      }),
      first.recipients ?? []
    ),
    characters: map((c: MailRow) => book.characters.get(c.registration_id) ?? c.registration_id, copies),
    // Read only when every copy is: reading it on one alt leaves the others unread.
    is_read: all((c: MailRow) => c.is_read, copies),
    labels: uniq(
      chain((c: MailRow) => map((l) => labelName(c.registration_id, Number(l), book), c.labels ?? []), copies)
    ),
    // Whether the extract has fetched the body yet. A header read carries no
    // body, so it cannot tell a copied body from a 404; read_mail can.
    body_copied: any((c: MailRow) => c.body_fetched_at != null, copies),
  }
}

/**
 * A whole mail as read_mail answers it: the header plus the body, as plain
 * text unless the raw EVE markup is asked for. A body is taken from whichever
 * copy holds one.
 */
export const shapeMail = (copies: MailRow[], book: NameBook, { raw = false } = {}) => {
  const { body_copied: _copied, ...header } = shapeHeader(copies, book)
  const stored = copies.find((c) => c.body != null)?.body ?? null
  const state = bodyState(copies)
  return {
    ...header,
    body: stored == null ? null : raw ? stored : mailText(stored),
    body_state: state,
    ...(state === 'pending' && {
      note: 'The body is not copied yet. The character-mail extract copies up to 100 bodies per character per run, newest first.',
    }),
    ...(state === 'deleted' && {
      note: 'The mail was deleted in game before its body was copied, so only the header is here.',
    }),
  }
}

/** The mail ids a read_mail call names, deduplicated; the bad ones reported separately. */
export const parseMailIds = (values: Array<string | number>): { ids: number[]; bad: string[] } => {
  const parsed = map((v: string | number) => ({ raw: String(v), id: parseId(v) }), values)
  return {
    ids: uniq(parsed.flatMap((p) => (p.id == null ? [] : [p.id]))),
    bad: parsed.flatMap((p) => (p.id == null ? [p.raw] : [])),
  }
}

/** Newest first, the order every answer lists mail in. */
export const byNewest = sortWith<MailRow>([
  (a, b) => (a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0),
  (a, b) => Number(b.mail_id) - Number(a.mail_id),
])
