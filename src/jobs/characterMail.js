import { map, pluck, splitEvery } from 'ramda'

import { mail, mailHeaders, mailingLists, mailLabels } from '../esi.js'
import { recordEsiConditional } from '../observability.js'
import { resolveAllIds } from '../resolveNames.js'
import { getEsiEtag, putEsiEtag, sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter, forEachSequential } from './lib.js'
import { labelRow, mailBodyPatch, mailHeaderRow, mailingListRow, nameableIds, walkPlan } from './mailFields.js'

const TAG = 'character-mail'
export const SCOPE = 'esi-mail.read_mail.v1'

// How many header pages (50 mails each) one character may walk per run, for the
// catch-up and for the backfill separately. ESI has no "how many mails" call,
// so a character with years of corp mail is copied over a few 6-hourly runs,
// newest first, rather than in one step.
const MAX_HEADER_PAGES = 20

// How many bodies one character may fetch per run — one call per mail, so the
// same reasoning as contracts' MAX_ITEM_FETCHES: a fresh grant drains over a
// few runs instead of firing a thousand requests in one step.
const MAX_BODY_FETCHES = 100

const UPSERT_CHUNK = 500

// The ids among `mailIds` this character already holds, read before a page is
// upserted so the walk can tell which mails the page brought.
const heldAmong = async (registration_id, mailIds) => {
  if (mailIds.length === 0) return new Set()
  const { data, error } = await sudoSupabase
    .from('character_mail')
    .select('mail_id')
    .eq('registration_id', registration_id)
    .in('mail_id', mailIds)
  if (error) throw error
  return new Set(map((r) => Number(r.mail_id), data ?? []))
}

// Upsert one page of headers in place on (registration_id, mail_id). The row
// carries no body columns, so an already-fetched body survives the overwrite.
const upsertHeaders = async (registration_id, rows) => {
  await forEachSequential(splitEvery(UPSERT_CHUNK, rows), async (chunk) => {
    const { error } = await sudoSupabase.from('character_mail').upsert(
      map((r) => ({ registration_id, ...r }), chunk),
      { onConflict: 'registration_id,mail_id' }
    )
    if (error) throw error
  })
}

const readSync = async (registration_id) => {
  const { data, error } = await sudoSupabase
    .from('character_mail_sync')
    .select('oldest_mail_id, backfill_complete')
    .eq('registration_id', registration_id)
    .maybeSingle()
  if (error) throw error
  return {
    oldest: data?.oldest_mail_id == null ? null : Number(data.oldest_mail_id),
    complete: data?.backfill_complete ?? false,
    exists: data != null,
  }
}

const writeSync = async (registration_id, { oldest, complete }) => {
  const { error } = await sudoSupabase.from('character_mail_sync').upsert(
    {
      registration_id,
      oldest_mail_id: oldest,
      backfill_complete: complete,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'registration_id' }
  )
  if (error) throw error
}

const lower = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b))

// Store one page: note which of its mails were already held, upsert it, and
// fold its smallest id into the walk's state. Returns the plan for the next
// page plus the rows written (for name resolution).
const storePage = async (registration_id, headers, mode, state) => {
  const seenAt = new Date().toISOString()
  const rows = map((h) => mailHeaderRow(h, seenAt), headers ?? [])
  const ids = pluck('mail_id', rows)
  const held = await heldAmong(registration_id, ids)
  await upsertHeaders(registration_id, rows)
  const plan = walkPlan(ids, held, { mode })
  return {
    plan,
    rows,
    state: {
      oldest: lower(state.oldest, plan.oldest),
      complete: state.complete || plan.exhausted,
    },
  }
}

// Tail-recursive header walk from `lastMailId` downwards, one unconditional
// page at a time, until the plan stops or the page budget runs out. The sync
// row is written after every page, so a step that dies mid-walk resumes from
// the last page it stored.
const walk = async (ctx, mode, lastMailId, state, pagesLeft, acc = []) => {
  if (lastMailId == null || pagesLeft <= 0) return { state, rows: acc }
  const { access_token, characterID, registration_id, name } = ctx
  const t0 = Date.now()
  const { json } = await mailHeaders(access_token, characterID, { lastMailId })
  recordEsiConditional({
    job: TAG,
    characterId: registration_id,
    characterName: name,
    outcome: 'modified',
    conditional: false,
    rows: json?.length ?? 0,
    durationMs: Date.now() - t0,
  })
  const page = await storePage(registration_id, json, mode, state)
  await writeSync(registration_id, page.state)
  acc.push(...page.rows)
  return walk(ctx, mode, page.plan.next, page.state, pagesLeft - 1, acc)
}

// Step 1: the newest page, conditionally, then down until a page brings
// nothing new. A character we have never walked skips the catch-up — every
// page would be new, so the budgeted backfill does that work instead. The
// catch-up shares the backfill's page budget: more than 1,000 new mails between
// two runs would leave a gap it never returns to, which a 6-hourly schedule
// does not come near.
const syncNewest = async (ctx, sync) => {
  const { access_token, characterID, registration_id, name } = ctx
  const cacheKey = `${TAG}:${registration_id}`
  const priorEtag = await getEsiEtag(cacheKey)
  const t0 = Date.now()
  const { status, json, etag } = await mailHeaders(access_token, characterID, { ifNoneMatch: priorEtag })
  const durationMs = Date.now() - t0
  if (status === 304) {
    recordEsiConditional({
      job: TAG,
      characterId: registration_id,
      characterName: name,
      outcome: 'not_modified',
      conditional: true,
      durationMs,
    })
    return { state: sync, rows: [], modified: false }
  }
  const first = await storePage(registration_id, json, 'catchup', sync)
  const next = sync.exists ? first.plan.next : null
  const walked = await walk(ctx, 'catchup', next, first.state, MAX_HEADER_PAGES - 1)
  await writeSync(registration_id, walked.state)
  // Only after every page above committed, so a mid-walk failure never leaves
  // us skipping a newest page whose mails we did not store.
  await putEsiEtag(cacheKey, etag)
  recordEsiConditional({
    job: TAG,
    characterId: registration_id,
    characterName: name,
    outcome: 'modified',
    conditional: priorEtag != null,
    rows: json?.length ?? 0,
    durationMs,
  })
  return { state: walked.state, rows: [...first.rows, ...walked.rows], modified: true }
}

// Step 2: while the backfill is incomplete, continue below the oldest mail we
// hold, up to the page budget; a short or empty page completes it.
const backfill = (ctx, state) =>
  state.complete || state.oldest == null
    ? Promise.resolve({ state, rows: [] })
    : walk(ctx, 'backfill', state.oldest, state, MAX_HEADER_PAGES)

// Step 3: bodies for mails that have none yet, newest first, over the
// body-owed partial index. One mail's failure is logged and left owed for the
// next run, never fatal to the character (the contract-items shape).
const syncBodies = async ({ access_token, characterID, registration_id, ctx }) => {
  const { data: owed, error } = await sudoSupabase
    .from('character_mail')
    .select('mail_id')
    .eq('registration_id', registration_id)
    .is('body_fetched_at', null)
    .order('sent_at', { ascending: false })
    .limit(MAX_BODY_FETCHES)
  if (error) throw error

  const tally = { fetched: 0, gone: 0, failed: 0, owed: owed?.length ?? 0 }
  await forEachSequential(owed ?? [], async ({ mail_id }) => {
    try {
      const { json } = await mail(access_token, characterID, mail_id)
      const { error: patchError } = await sudoSupabase
        .from('character_mail')
        .update(mailBodyPatch(json, new Date().toISOString()))
        .eq('registration_id', registration_id)
        .eq('mail_id', mail_id)
      if (patchError) throw patchError
      if (json == null) tally.gone += 1
      else tally.fetched += 1
    } catch (e) {
      tally.failed += 1
      console.error(`[${TAG}] ${ctx}: mail ${mail_id} body FAILED message=${e?.message}`)
    }
  })
  return tally
}

// Step 4: labels and mailing lists, upserted in place. One that disappears is
// left; nothing reads them to decide anything.
const syncLabelsAndLists = async ({ access_token, characterID, registration_id }) => {
  const [labels, lists] = await Promise.all([
    mailLabels(access_token, characterID),
    mailingLists(access_token, characterID),
  ])
  const labelRows = map((l) => ({ registration_id, ...labelRow(l) }), labels?.labels ?? [])
  const listRows = map((l) => ({ registration_id, ...mailingListRow(l) }), lists ?? [])
  if (labelRows.length > 0) {
    const { error } = await sudoSupabase
      .from('character_mail_label')
      .upsert(labelRows, { onConflict: 'registration_id,label_id' })
    if (error) throw error
  }
  if (listRows.length > 0) {
    const { error } = await sudoSupabase
      .from('character_mailing_list')
      .upsert(listRows, { onConflict: 'registration_id,mailing_list_id' })
    if (error) throw error
  }
  return { labels: labelRows.length, lists: listRows.length, listIds: new Set(pluck('mailing_list_id', listRows)) }
}

// Best-effort: cache the names of this run's new senders and recipients in
// universe_name, so a later reader has them. Mailing lists are skipped —
// universe/names does not know them; character_mailing_list names them.
const resolveNames = async (rows, listIds, ctx) => {
  try {
    const ids = nameableIds(rows, listIds)
    if (ids.length === 0) return 0
    const known = new Set(map(Number, await chunkedKnown(ids)))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length === 0) return 0
    const resolved = await resolveAllIds(unknown)
    if (resolved.length === 0) return 0
    const { error } = await sudoSupabase.from('universe_name').upsert(
      map(({ id, name, category }) => ({ id, name, category }), resolved),
      { onConflict: 'id' }
    )
    if (error) throw error
    return resolved.length
  } catch (e) {
    console.warn(`[${TAG}] ${ctx}: name resolution skipped message=${e?.message}`)
    return 0
  }
}

const chunkedKnown = async (ids, chunks = splitEvery(1000, ids), acc = []) => {
  if (chunks.length === 0) return acc
  const [head, ...rest] = chunks
  const { data, error } = await sudoSupabase.from('universe_name').select('id').in('id', head)
  if (error) throw error
  acc.push(...pluck('id', data ?? []))
  return chunkedKnown(ids, rest, acc)
}

// GET /characters/{id}/mail/ (+ /mail/{id}/, /mail/labels/, /mail/lists/) →
// character_mail, character_mail_label, character_mailing_list, with the walk's
// position in character_mail_sync. A copy of the mailbox that outlives it:
// rows are upserted in place and never deleted. See docs/eve-mail.md.
export const runCharacterMail = ({ registrationIds } = {}) =>
  forEachCharacter(
    TAG,
    { scope: SCOPE, registrationIds },
    async ({ access_token, characterID, registration_id, name, ctx }) => {
      const job = { access_token, characterID, registration_id, name, ctx }
      const sync = await readSync(registration_id)
      const newest = await syncNewest(job, sync)
      const filled = await backfill(job, newest.state)
      const bodies = await syncBodies(job)
      const { labels, lists, listIds } = await syncLabelsAndLists(job)
      const named = await resolveNames([...newest.rows, ...filled.rows], listIds, ctx)
      console.log(
        `[${TAG}] ${name} ${registration_id} (${characterID}): ` +
          `${newest.modified ? `${newest.rows.length} newest header(s)` : 'newest not modified'}, ` +
          `${filled.rows.length} backfilled (${filled.state.complete ? 'complete' : 'continuing'}); ` +
          `${bodies.owed} body(ies) owed, ${bodies.fetched} fetched, ${bodies.gone} gone, ${bodies.failed} failed; ` +
          `${labels} label(s), ${lists} list(s), ${named} name(s) resolved`
      )
    }
  )

cli(import.meta.url, TAG, runCharacterMail)
