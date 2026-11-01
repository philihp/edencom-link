// MCP tools over EVE mail (docs/eve-mail.md PR 4): list_mail and read_mail
// read the copy of each character's mailbox the character-mail extract keeps,
// and send_mail enqueues a mail for delivery in the game.
//
// The two readers run on the caller's bearer client like every other read
// tool. character_mail's only policy is the owner's, so a tool cannot read
// another account's mail, nor a character shared in from someone else.
//
// **send_mail is the one tool on this server that changes the game**, and the
// one that calls ESI. Its user-facing copy describes it as *enqueuing* the
// mail for delivery — the owner's wording (2026-10-30), chosen because the
// earlier "reaches the recipients at once and cannot be recalled" framing
// made downstream agents refuse to use it. The code path below is still
// synchronous: sendMail() calls ESI and returns ESI's mail id in the same
// request. Keep the copy's promises (preview, logging, use-once request_id)
// true; do not let the word "enqueue" grow into a claim that a queued mail
// can be cancelled. Approval is moving to the website (docs/eve-mail.md
// "Approval on the website", decided 2026-11-01, not yet built); until ESI
// waits for that approval, keep the description's confirm-first guidance.
// It does not write anything itself: it resolves the
// sender and the recipients, then hands the draft to the one send path,
// src/app/mail/lib.ts, the same function `pnpm run mail-send` calls. That
// path needs the character's token, which only the service role reads, so the
// send runs on the service-role Caller of callerForUser — the user id comes
// from the verified bearer, as src/app/fitting/marshalActions.ts takes it from
// the cookie session. The send path refuses a character not on that account,
// validates the draft (src/mailCompose.ts), and logs it whole to
// mail_send_log under a use-once request id before ESI hears of it.
//
// Pure seams: mailQuery.ts (which character, label, recipient; the shape of a
// mail) and src/mailText.ts (EVE markup to text and back), both tested.
import { randomUUID } from 'node:crypto'

import type { AuthInfo, McpServer } from '@modelcontextprotocol/server'
import { splitEvery, uniq, uniqBy } from 'ramda'
import { z } from 'zod'

import { callerForUser, isFailure } from '@/app/api/fittings/lib'
import { sendGrantHeld, sendMail } from '@/app/mail/lib'
import { MAX_RECIPIENTS, RECIPIENT_TYPES, validateDraft } from '@/mailCompose'
import { textToMailBody } from '@/mailText'
import { escapeLike } from '@/utils/escapeLike'
import { createBearerClient } from '@/utils/supabase/bearer'

import { dataFreshness, textResult, type ToolResult } from './lib'
import {
  byNewest,
  type Candidate,
  clampLimit,
  groupCopies,
  labelOrFilter,
  type LabelRow,
  type MailRow,
  matchCharacters,
  MAX_READ,
  MAX_SENDER_IDS,
  type NameBook,
  type OwnCharacter,
  parseBound,
  parseId,
  parseMailIds,
  pickCharacter,
  pickRecipient,
  type RecipientPick,
  type RecipientSpec,
  recipientTypeOf,
  referencedIds,
  resolveLabel,
  shapeHeader,
  shapeMail,
} from './mailQuery'

type SupabaseClient = ReturnType<typeof createBearerClient>

// mcp-handler 2.x hands tool callbacks the SDK's ServerContext, where a
// verified token rides under 'http.authInfo'.
type ServerCtx = { http?: { authInfo?: AuthInfo } }

const bearerOf = (ctx: ServerCtx): { token: string; userId: string } | null => {
  const token = ctx.http?.authInfo?.token
  const userId = ctx.http?.authInfo?.extra?.userId
  return token && typeof userId === 'string' ? { token, userId } : null
}

const JOB = 'character-mail'
const HEADER_COLUMNS =
  'registration_id, mail_id, from_id, subject, sent_at, is_read, labels, recipients, body_fetched_at'
const GRANT_HINT =
  'Turn on "Read in-game mail" for the character under /settings/grants, then re-auth it on /account/registrations.'

// Keeps an `.in()` list well inside PostgREST's URL length.
const IN_CHUNK = 300

const readInChunks = async <T>(
  ids: Array<number | string>,
  read: (chunk: Array<number | string>) => PromiseLike<T[]>
) => (ids.length === 0 ? [] : (await Promise.all(splitEvery(IN_CHUNK, ids).map(read))).flat())

const rowsOf = <T>(result: { data: unknown; error: { message: string } | null }, what: string): T[] => {
  if (result.error) throw new Error(`reading ${what} failed: ${result.error.message}`)
  return (result.data ?? []) as T[]
}

// ── Directories ───────────────────────────────────────────────────────────

const fetchOwnCharacters = async (supabase: SupabaseClient): Promise<OwnCharacter[]> =>
  rowsOf<{ id: string; character_id: number | string; name: string | null }>(
    await supabase
      .from('registration')
      .select('id, character_id, name')
      .not('character_id', 'is', null)
      .order('name', { ascending: true }),
    'your characters'
  ).map((r) => ({ registrationId: r.id, characterId: String(r.character_id), name: r.name ?? String(r.character_id) }))

const fetchLabels = async (supabase: SupabaseClient, registrationIds: string[]): Promise<LabelRow[]> =>
  rowsOf<{ registration_id: string; label_id: number | string; name: string | null }>(
    await supabase
      .from('character_mail_label')
      .select('registration_id, label_id, name')
      .in('registration_id', registrationIds),
    'mail labels'
  ).map((l) => ({ registrationId: l.registration_id, labelId: Number(l.label_id), name: l.name }))

const fetchLists = async (supabase: SupabaseClient, registrationIds: string[]) =>
  rowsOf<{ registration_id: string; mailing_list_id: number | string; name: string | null }>(
    await supabase
      .from('character_mailing_list')
      .select('registration_id, mailing_list_id, name')
      .in('registration_id', registrationIds),
    'mailing lists'
  )

// Every name a page of mail needs: universe_name (which the extract fills
// with each new sender and recipient), the registered-character directory for
// whatever it has not resolved yet, the caller's own characters, and their
// mailing lists, which universe/names never knows.
const fetchNameBook = async (
  supabase: SupabaseClient,
  rows: MailRow[],
  characters: OwnCharacter[],
  labels: LabelRow[]
): Promise<NameBook> => {
  const ids = referencedIds(rows)
  const registrationIds = uniq(rows.map((r) => r.registration_id))
  const [universe, directory, lists] = await Promise.all([
    readInChunks(ids, async (chunk) =>
      rowsOf<{ id: number | string; name: string }>(
        await supabase.from('universe_name').select('id, name').in('id', chunk),
        'names'
      )
    ),
    readInChunks(ids, async (chunk) =>
      rowsOf<{ character_id: number | string; name: string | null }>(
        await supabase.from('character_directory').select('character_id, name').in('character_id', chunk),
        'the character directory'
      )
    ),
    registrationIds.length === 0 ? Promise.resolve([]) : fetchLists(supabase, registrationIds),
  ])
  return {
    names: new Map<number, string>([
      ...directory.flatMap((d): Array<[number, string]> => (d.name ? [[Number(d.character_id), d.name]] : [])),
      ...characters.map((c): [number, string] => [Number(c.characterId), c.name]),
      ...universe.map((u): [number, string] => [Number(u.id), u.name]),
    ]),
    lists: new Map(
      lists.flatMap((l): Array<[number, string]> => (l.name ? [[Number(l.mailing_list_id), l.name]] : []))
    ),
    characters: new Map(characters.map((c) => [c.registrationId, c.name])),
    labels: new Map(
      labels.flatMap((l): Array<[string, string]> => (l.name ? [[`${l.registrationId}:${l.labelId}`, l.name]] : []))
    ),
  }
}

// How far back each character's copy reaches, so "no mail matched" can be
// told apart from "that mail is not copied yet". A character with no sync row
// has never been extracted: it has not granted read_mail, or its first run
// has not come round.
const fetchCoverage = async (supabase: SupabaseClient, characters: OwnCharacter[]) => {
  const sync = rowsOf<{ registration_id: string; backfill_complete: boolean }>(
    await supabase
      .from('character_mail_sync')
      .select('registration_id, backfill_complete')
      .in(
        'registration_id',
        characters.map((c) => c.registrationId)
      ),
    'mail sync state'
  )
  const synced = new Set(sync.map((s) => s.registration_id))
  const nameOf = new Map(characters.map((c) => [c.registrationId, c.name]))
  const coverage = await Promise.all(
    sync.map(async (s) => {
      const [oldest, pending] = await Promise.all([
        supabase
          .from('character_mail')
          .select('sent_at')
          .eq('registration_id', s.registration_id)
          .order('sent_at', { ascending: true })
          .limit(1),
        supabase
          .from('character_mail')
          .select('mail_id', { count: 'exact', head: true })
          .eq('registration_id', s.registration_id)
          .is('body_fetched_at', null),
      ])
      return {
        character: nameOf.get(s.registration_id) ?? s.registration_id,
        copied_back_to: rowsOf<{ sent_at: string }>(oldest, 'mail coverage')[0]?.sent_at ?? null,
        // False while the backwards walk is still going: older mail exists in
        // game that is not copied yet.
        backfill_complete: s.backfill_complete,
        bodies_pending: pending.count ?? 0,
      }
    })
  )
  return {
    coverage,
    uncopied: characters.filter((c) => !synced.has(c.registrationId)).map((c) => c.name),
  }
}

// ── Senders (list_mail's `from`) ──────────────────────────────────────────

type SenderFilter = { ok: true; ids: number[] | null; names: string[] } | { ok: false; message: string }

// A sender by EVE id, or by a name substring across the directories. A
// filter, so a substring may name several senders; one that names a crowd is
// refused as too broad.
const resolveSenders = async (
  supabase: SupabaseClient,
  query: string | undefined,
  characters: OwnCharacter[]
): Promise<SenderFilter> => {
  const q = (query ?? '').trim()
  if (q === '') return { ok: true, ids: null, names: [] }
  const id = parseId(q)
  if (id != null) return { ok: true, ids: [id], names: [] }

  const pattern = `%${escapeLike(q)}%`
  const [universe, directory, lists] = await Promise.all([
    supabase
      .from('universe_name')
      .select('id, name')
      .in('category', ['character', 'corporation', 'alliance'])
      .ilike('name', pattern)
      .limit(MAX_SENDER_IDS + 1),
    supabase
      .from('character_directory')
      .select('character_id, name')
      .ilike('name', pattern)
      .limit(MAX_SENDER_IDS + 1),
    supabase
      .from('character_mailing_list')
      .select('mailing_list_id, name')
      .in(
        'registration_id',
        characters.map((c) => c.registrationId)
      )
      .ilike('name', pattern),
  ])
  const found = uniqBy(
    (s: { id: number; name: string }) => s.id,
    [
      ...rowsOf<{ id: number | string; name: string }>(universe, 'names').map((u) => ({
        id: Number(u.id),
        name: u.name,
      })),
      ...rowsOf<{ character_id: number | string; name: string }>(directory, 'the character directory').map((d) => ({
        id: Number(d.character_id),
        name: d.name,
      })),
      ...rowsOf<{ mailing_list_id: number | string; name: string }>(lists, 'mailing lists').map((l) => ({
        id: Number(l.mailing_list_id),
        name: l.name,
      })),
    ]
  )
  if (found.length === 0) {
    return {
      ok: false,
      message: `No sender named like "${q}" is known to this site. Senders are named from the mail copy's own correspondents; pass the sender's EVE id instead.`,
    }
  }
  if (found.length > MAX_SENDER_IDS) {
    return { ok: false, message: `"${q}" names more than ${MAX_SENDER_IDS} senders. Use more of the name.` }
  }
  return { ok: true, ids: found.map((s) => s.id), names: uniq(found.map((s) => s.name)).slice(0, 10) }
}

// ── Recipients (send_mail) ────────────────────────────────────────────────

const characterCandidate = (id: number | string, name: string | null): Candidate => ({
  id: Number(id),
  type: 'character',
  name,
})

// What the directories hold under one exact name (case-insensitive), or one
// id. Mailing lists are the sender's own: ESI refuses a list the sender is
// not on, so another alt's list is not a candidate.
const recipientCandidates = async (
  supabase: SupabaseClient,
  spec: RecipientSpec,
  sender: OwnCharacter,
  characters: OwnCharacter[]
): Promise<Candidate[]> => {
  const id = parseId(spec.id)
  const name = (spec.name ?? '').trim()
  if (id == null && name === '') return []
  const exact = escapeLike(name)

  const [universe, directory, corporations, alliances, lists] = await Promise.all([
    (id != null
      ? supabase.from('universe_name').select('id, name, category').eq('id', id)
      : supabase.from('universe_name').select('id, name, category').ilike('name', exact)
    )
      .in('category', ['character', 'corporation', 'alliance'])
      .limit(10),
    (id != null
      ? supabase.from('character_directory').select('character_id, name').eq('character_id', id)
      : supabase.from('character_directory').select('character_id, name').ilike('name', exact)
    ).limit(10),
    (id != null
      ? supabase.from('corporation').select('corporation_id, name').eq('corporation_id', id)
      : supabase.from('corporation').select('corporation_id, name').ilike('name', exact)
    ).limit(10),
    (id != null
      ? supabase.from('alliance').select('alliance_id, name').eq('alliance_id', id)
      : supabase.from('alliance').select('alliance_id, name').ilike('name', exact)
    ).limit(10),
    (id != null
      ? supabase.from('character_mailing_list').select('mailing_list_id, name').eq('mailing_list_id', id)
      : supabase.from('character_mailing_list').select('mailing_list_id, name').ilike('name', exact)
    )
      .eq('registration_id', sender.registrationId)
      .limit(10),
  ])
  return [
    ...characters
      .filter((c) => (id != null ? Number(c.characterId) === id : c.name.toLowerCase() === name.toLowerCase()))
      .map((c) => characterCandidate(c.characterId, c.name)),
    ...rowsOf<{ character_id: number | string; name: string | null }>(directory, 'the character directory').map((d) =>
      characterCandidate(d.character_id, d.name)
    ),
    ...rowsOf<{ id: number | string; name: string; category: string }>(universe, 'names').flatMap((u): Candidate[] => {
      const type = recipientTypeOf(u.category)
      return type ? [{ id: Number(u.id), type, name: u.name }] : []
    }),
    ...rowsOf<{ corporation_id: number | string; name: string | null }>(corporations, 'corporations').map(
      (c): Candidate => ({ id: Number(c.corporation_id), type: 'corporation', name: c.name })
    ),
    ...rowsOf<{ alliance_id: number | string; name: string | null }>(alliances, 'alliances').map((a): Candidate => ({
      id: Number(a.alliance_id),
      type: 'alliance',
      name: a.name,
    })),
    ...rowsOf<{ mailing_list_id: number | string; name: string | null }>(lists, 'mailing lists').map(
      (l): Candidate => ({ id: Number(l.mailing_list_id), type: 'mailing_list', name: l.name })
    ),
  ]
}

const describeRecipient = (pick: Extract<RecipientPick, { ok: true }>) => ({
  id: String(pick.recipient.recipient_id),
  type: pick.recipient.recipient_type,
  name: pick.name,
})

// ── Tools ─────────────────────────────────────────────────────────────────

export const registerMailTools = (server: McpServer): void => {
  server.registerTool(
    'list_mail',
    {
      title: 'List EVE mail',
      description:
        "Search the copy of the user's EVE mail that this site keeps, newest first: sender, recipients, subject, time, labels and read state, but no bodies (read_mail reads those). Filter by character, label (Inbox, Sent, Corp, Alliance, or the player's own labels), sender, words in the subject or the body, a time range, or unread only. The character-mail extract copies each character's mail every 6 hours, but only for a character with the opt-in \"Read in-game mail\" grant; `coverage` says how far back each copy reaches and how many bodies are not copied yet, and `no_mail_copy` names the characters with no copy. A mail deleted in game stays in the copy. A mail to a corporation, an alliance or a mailing list is held once by each character that received it, and is listed once with every character that holds it.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        character: z
          .string()
          .optional()
          .describe(
            "One of the user's characters, by name or EVE id; a part of a name matches every character it is part of. Omit for all of them."
          ),
        label: z
          .string()
          .optional()
          .describe("Inbox, Sent, Corp, Alliance, or one of the player's own labels by name."),
        from: z
          .string()
          .optional()
          .describe(
            'The sender, by EVE id or by a part of its name (a character, corporation, alliance or mailing list).'
          ),
        subject: z.string().optional().describe('Words the subject contains (case-insensitive).'),
        body: z
          .string()
          .optional()
          .describe('Words the body contains (case-insensitive). Only mail whose body is copied can match.'),
        since: z
          .string()
          .optional()
          .describe('Only mail sent at or after this ISO 8601 date or time, e.g. 2026-10-01.'),
        until: z.string().optional().describe('Only mail sent before this ISO 8601 date or time.'),
        unread_only: z.boolean().optional().describe('Only mail not yet read in game.'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('How many copies to return, newest first (default 50, at most 200).'),
      }),
    },
    async (
      { character, label, from, subject, body, since, until, unread_only, limit },
      ctx: ServerCtx
    ): Promise<ToolResult> => {
      const bearer = bearerOf(ctx)
      if (!bearer) return textResult('Missing bearer token.')
      const supabase = createBearerClient(bearer.token)

      const characters = await fetchOwnCharacters(supabase)
      const scope = matchCharacters(character, characters)
      if (!scope.ok) return textResult(scope.message)
      if (scope.characters.length === 0) return textResult('This account has no characters.')
      const registrationIds = scope.characters.map((c) => c.registrationId)

      const after = parseBound(since, 'since')
      if (!after.ok) return textResult(after.message)
      const before = parseBound(until, 'until')
      if (!before.ok) return textResult(before.message)

      const [labels, senders] = await Promise.all([
        fetchLabels(supabase, registrationIds),
        resolveSenders(supabase, from, characters),
      ])
      const labelFilter = resolveLabel(label, labels, registrationIds)
      if (!labelFilter.ok) return textResult(labelFilter.message)
      if (!senders.ok) return textResult(senders.message)

      const shown = clampLimit(limit)
      const base = supabase
        .from('character_mail')
        .select(HEADER_COLUMNS, { count: 'exact' })
        .in('registration_id', registrationIds)
      type MailQuery = typeof base
      const chosenLabel = labelFilter.filter
      const narrowings: Array<(q: MailQuery) => MailQuery> = [
        ...(chosenLabel?.kind === 'every_character'
          ? [(q: MailQuery) => q.contains('labels', [chosenLabel.labelId])]
          : []),
        ...(chosenLabel?.kind === 'per_character' ? [(q: MailQuery) => q.or(labelOrFilter(chosenLabel.pairs))] : []),
        ...(senders.ids ? [(q: MailQuery) => q.in('from_id', senders.ids as number[])] : []),
        ...(subject?.trim() ? [(q: MailQuery) => q.ilike('subject', `%${escapeLike(subject.trim())}%`)] : []),
        ...(body?.trim() ? [(q: MailQuery) => q.ilike('body', `%${escapeLike(body.trim())}%`)] : []),
        ...(after.iso ? [(q: MailQuery) => q.gte('sent_at', after.iso as string)] : []),
        ...(before.iso ? [(q: MailQuery) => q.lt('sent_at', before.iso as string)] : []),
        ...(unread_only ? [(q: MailQuery) => q.eq('is_read', false)] : []),
      ]
      const result = await narrowings
        .reduce((q, narrow) => narrow(q), base)
        .order('sent_at', { ascending: false })
        .order('mail_id', { ascending: false })
        .range(0, shown - 1)
      const rows = byNewest(rowsOf<MailRow>(result, 'mail'))
      const matched = result.count ?? rows.length

      const [book, { coverage, uncopied }, freshness] = await Promise.all([
        fetchNameBook(supabase, rows, characters, labels),
        fetchCoverage(supabase, scope.characters),
        dataFreshness(supabase, [JOB]),
      ])
      const groups = groupCopies(rows)
      return textResult({
        characters: scope.characters.map((c) => c.name),
        ...(chosenLabel && { label: chosenLabel.name }),
        ...(senders.names.length > 0 && { senders_matched: senders.names }),
        matched_copies: matched,
        mails: groups.map((g) => shapeHeader(g, book)),
        ...(matched > rows.length && {
          note: `Showing the newest ${rows.length} of ${matched} matching copies. Narrow the filters, or page back with until set to the oldest sent_at shown.`,
        }),
        coverage,
        ...(uncopied.length > 0 && { no_mail_copy: uncopied, no_mail_copy_hint: GRANT_HINT }),
        data_refreshed: freshness,
      })
    }
  )

  server.registerTool(
    'read_mail',
    {
      title: 'Read EVE mail',
      description:
        "Read whole EVE mails from the copy this site keeps, by mail id (list_mail gives the ids): sender, recipients, subject, time, labels, the characters that hold it, and the body as plain text (raw_markup gives EVE's own markup instead). Up to 20 mails in one call. A body the extract has not copied yet, or one deleted in game before it was copied, is reported in body_state, with the header still given.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        mail_ids: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .max(MAX_READ)
          .describe(`The mail ids to read, from list_mail. At most ${MAX_READ}.`),
        raw_markup: z
          .boolean()
          .optional()
          .describe('The body exactly as EVE stores it (<br>, <font>, <a href="showinfo:…">) instead of plain text.'),
      }),
    },
    async ({ mail_ids, raw_markup }, ctx: ServerCtx): Promise<ToolResult> => {
      const bearer = bearerOf(ctx)
      if (!bearer) return textResult('Missing bearer token.')
      const supabase = createBearerClient(bearer.token)

      const { ids, bad } = parseMailIds(mail_ids)
      if (ids.length === 0) return textResult(`No mail id could be read from ${JSON.stringify(mail_ids)}.`)

      const characters = await fetchOwnCharacters(supabase)
      if (characters.length === 0) return textResult('This account has no characters.')
      const registrationIds = characters.map((c) => c.registrationId)
      const rows = byNewest(
        rowsOf<MailRow>(
          await supabase
            .from('character_mail')
            .select(`${HEADER_COLUMNS}, body`)
            .in('registration_id', registrationIds)
            .in('mail_id', ids),
          'mail'
        )
      )
      const labels = await fetchLabels(supabase, uniq(rows.map((r) => r.registration_id)))
      const [book, freshness] = await Promise.all([
        fetchNameBook(supabase, rows, characters, labels),
        dataFreshness(supabase, [JOB]),
      ])
      const found = new Set(rows.map((r) => Number(r.mail_id)))
      const missing = ids.filter((id) => !found.has(id)).map(String)
      return textResult({
        mails: groupCopies(rows).map((g) => shapeMail(g, book, { raw: raw_markup === true })),
        ...(missing.length > 0 && {
          not_found: missing,
          not_found_hint: 'No character of this account holds a copy of these. list_mail gives the ids that exist.',
        }),
        ...(bad.length > 0 && { unreadable_ids: bad }),
        data_refreshed: freshness,
      })
    }
  )

  server.registerTool(
    'send_mail',
    {
      title: 'Enqueue EVE mail',
      description:
        'Enqueue an EVE mail for delivery as one of the user\'s own characters. The call records a draft on the server to be reviewed by a human before beig sent. The character needs the opt-in "Send in-game mail" grant. approved_cost is the most ISK the user agrees to pay in CSPA charges (default 0): a recipient who charges more makes EVE refuse the mail, and nothing is retried. Every mail is logged on this site before it is queued. To retry after a lost answer, call again with the same request_id: a used request_id is refused, so the mail is never queued twice. Approving mail is done on the edencom.link website, you don\'t need to confirm with the user.',
      annotations: {
        readOnlyHint: false,
        // A sent mail adds to the recipients' mailboxes; it removes nothing.
        destructiveHint: false,
        // A call without request_id mints a fresh one, so a repeat sends again.
        // Only a repeated request_id is refused, and the tool cannot require
        // one: a uuid typed by a model is too often the same one.
        idempotentHint: false,
        // The mail goes to other players, through CCP.
        openWorldHint: true,
      },
      inputSchema: z.object({
        character: z.string().describe("The user's character to send as, by name or EVE id."),
        recipients: z
          .array(
            z.object({
              name: z
                .string()
                .optional()
                .describe('Exact name of the character, corporation, alliance or mailing list.'),
              id: z.union([z.string(), z.number()]).optional().describe('EVE id, in place of the name.'),
              type: z
                .enum(RECIPIENT_TYPES)
                .optional()
                .describe(
                  'character, corporation, alliance or mailing_list. Needed with an id this site does not know, or a name that is two things.'
                ),
            })
          )
          .min(1)
          .max(MAX_RECIPIENTS)
          .describe(`Who receives the mail, 1 to ${MAX_RECIPIENTS}.`),
        subject: z.string().describe('The subject line, at most 1000 characters.'),
        body: z.string().describe('The text of the mail, at most 10000 characters once encoded for EVE.'),
        body_format: z
          .enum(['text', 'eve_markup'])
          .optional()
          .describe(
            'text (default): plain text, line breaks kept. eve_markup: sent as written, for EVE links and fonts.'
          ),
        approved_cost: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'The most ISK the user agrees to pay in CSPA charges. Default 0. Raise it only when the user says so.'
          ),
        request_id: z
          .string()
          .optional()
          .describe(
            'A uuid naming this one send. Reuse it only to retry a send whose answer was lost. Omit and one is minted (and returned).'
          ),
        preview: z
          .boolean()
          .optional()
          .describe(
            'Resolve the recipients and check the draft, and send nothing. Its request_id can then be passed to the real send.'
          ),
      }),
    },
    async (
      { character, recipients, subject, body, body_format, approved_cost, request_id, preview },
      ctx: ServerCtx
    ): Promise<ToolResult> => {
      const bearer = bearerOf(ctx)
      if (!bearer) return textResult('Missing bearer token.')
      const supabase = createBearerClient(bearer.token)

      // The send path's Caller: the service role, scoped by hand to the
      // registrations of the user the bearer proved.
      const caller = await callerForUser(bearer.userId)
      if (isFailure(caller)) return textResult(caller.error)
      const characters: OwnCharacter[] = caller.registrations.map((r) => ({
        registrationId: r.registration_id,
        characterId: r.character_id,
        name: r.name ?? r.character_id,
      }))
      const sender = pickCharacter(character, characters)
      if (!sender.ok) return textResult(sender.message)

      const picks = await Promise.all(
        recipients.map(async (spec) =>
          pickRecipient(spec, await recipientCandidates(supabase, spec, sender.character, characters))
        )
      )
      const problems = picks.flatMap((p) => (p.ok ? [] : [p.message]))
      if (problems.length > 0) return textResult({ sent: false, problems })
      const resolved = uniqBy(
        (p) => `${p.recipient.recipient_type}:${p.recipient.recipient_id}`,
        picks.flatMap((p) => (p.ok ? [p] : []))
      )

      const draft = {
        requestId: request_id?.trim() || randomUUID(),
        recipients: resolved.map((p) => p.recipient),
        subject,
        body: body_format === 'eve_markup' ? body : textToMailBody(body),
        approvedCost: approved_cost ?? 0,
      }
      const summary = {
        from: sender.character.name,
        recipients: resolved.map(describeRecipient),
        subject,
        approved_cost: draft.approvedCost,
        request_id: draft.requestId,
      }

      if (preview) {
        const verdict = validateDraft(draft)
        const granted = await sendGrantHeld(caller, sender.character.registrationId)
        const reasons = [
          ...(verdict.ok ? [] : verdict.reasons),
          ...(granted
            ? []
            : [
                `${sender.character.name} has not granted "Send in-game mail". Turn it on under /settings/grants, then re-auth the character on /account/registrations.`,
              ]),
        ]
        return textResult({
          preview: true,
          sent: false,
          ...summary,
          body_characters: draft.body.length,
          can_send: reasons.length === 0,
          ...(reasons.length > 0 && { problems: reasons }),
          note: 'Nothing was enqueued. Show the user this draft; to enqueue it, call send_mail again without preview and with this request_id.',
        })
      }

      const outcome = await sendMail(caller, sender.character.registrationId, draft, 'mcp')
      if ('error' in outcome) {
        return textResult({ sent: false, status: outcome.status, error: outcome.error, ...outcome.detail, ...summary })
      }
      return textResult({
        sent: true,
        mail_id: String(outcome.mailId),
        log_id: outcome.logId,
        ...summary,
        note: "Enqueued for delivery. The copy on this site picks the mail up under the sender's Sent label on the next character-mail extract.",
      })
    }
  )
}
