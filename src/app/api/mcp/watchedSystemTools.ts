// MCP tool for editing the caller's /indexes watch list — the ordered set of
// solar systems the industry-systems extract snapshots cost indices for, and
// the systems industry_cost_indices falls back to when no system is named.
// Until now that list could only be curated in the browser (search box, drag
// to reorder), which left a model able to read the indices but not to fix the
// list they came from.
//
// **This is a write tool**, the second write surface on the server after
// linkTools.ts, and the same three things keep it narrow:
//
//   * It writes on the caller's own bearer client, so RLS pins every row to
//     them exactly as the /indexes server actions' cookie session does. The
//     watched_system policy is `user_id = auth.uid()` for all commands, so a
//     tool cannot touch another account's watch list.
//   * It only ever touches watched_system. Nothing here reaches the extracted
//     game data, and nothing here calls ESI.
//   * System ids come from the nightly SDE mirror, never from the caller, so
//     an id that isn't a real known-space system can't be written.
//
// The indexing rules — and the argument about what UPDATE's index means — live
// in the pure watchedSystemQuery.ts seam next door (docs/mcp-watched-systems.md).
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { formatSecurity, getSdeSystems, searchSdeSystems } from '@/sdeSystems'
import { createBearerClient } from '@/utils/supabase/bearer'

import { textResult, type ToolResult } from './lib'
import { MAX_WATCHED_SYSTEMS, planEdit, selectIndexes, writePlan } from './watchedSystemQuery'

type SupabaseClient = ReturnType<typeof createBearerClient>

// mcp-handler 2.x hands tool callbacks the SDK's ServerContext, where a
// verified token rides under 'http.authInfo'.
type ServerCtx = { http?: { authInfo?: AuthInfo } }

// The write needs the user id as well as the client: watched_system's primary
// key leads with user_id, so an upsert has to name it (RLS then checks it
// against auth.uid(), which is what actually stops a forged one).
type Caller = { supabase: SupabaseClient; userId: string }

const callerFor = (ctx: ServerCtx): Caller | null => {
  const token = ctx.http?.authInfo?.token
  const userId = ctx.http?.authInfo?.extra?.userId
  if (!token || typeof userId !== 'string') return null
  return { supabase: createBearerClient(token), userId }
}

// How many systems a fuzzy SELECT query may resolve to. A watch list is at
// most MAX_WATCHED_SYSTEMS long, so a wider net can't add anything to the
// answer — anything past this can't be on the list to be found.
const SELECT_CANDIDATES = MAX_WATCHED_SYSTEMS

// ── System resolution ─────────────────────────────────────────────────────

type ResolvedSystem = { ok: true; systemID: number; name: string } | { ok: false; message: string }

// A system to be written has to resolve to exactly one, so an edit can never
// land on a system the caller didn't mean. An exact (case-insensitive) name
// always wins — "Jita" is Jita even though the search also ranks Jitanare —
// and anything else has to be unambiguous on its own.
const resolveOneSystem = async (query: string): Promise<ResolvedSystem> => {
  const trimmed = query.trim()
  if (trimmed === '') return { ok: false, message: 'Name a solar system, e.g. "C-J6MT".' }
  const matches = await searchSdeSystems(trimmed, 10)
  if (matches.length === 0) {
    return {
      ok: false,
      message: `No solar system matched "${trimmed}". The watch list is drawn from the SDE mirror, which covers known space only — wormhole systems can't be watched.`,
    }
  }
  const exact = matches.find((m) => m.name.toLowerCase() === trimmed.toLowerCase())
  if (exact) return { ok: true, systemID: exact.systemID, name: exact.name }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `"${trimmed}" matched ${matches.length} solar systems: ${matches.map((m) => m.name).join(', ')}. Name one exactly.`,
    }
  }
  return { ok: true, systemID: matches[0].systemID, name: matches[0].name }
}

// SELECT resolves fuzzily on purpose: the answer is a row of indexes, so a
// query matching several systems is a question with several answers rather
// than an ambiguity to refuse.
const resolveCandidates = async (query: string): Promise<{ query: string; systemIds: number[]; names: string[] }> => {
  const matches = await searchSdeSystems(query.trim(), SELECT_CANDIDATES)
  return { query: query.trim(), systemIds: matches.map((m) => m.systemID), names: matches.map((m) => m.name) }
}

// ── The watch list itself ─────────────────────────────────────────────────

// The caller's list in their own order — the same ordering /indexes renders
// (position, then created_at as the tiebreak for rows that predate the drag
// column's backfill). RLS scopes the read to the caller.
const fetchWatchList = async (supabase: SupabaseClient): Promise<number[]> => {
  const { data, error } = await supabase
    .from('watched_system')
    .select('system_id')
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(`reading the watch list failed: ${error.message}`)
  return ((data ?? []) as Array<{ system_id: number | string }>).map((r) => Number(r.system_id))
}

// Persist an edit: drop whatever left the list, then rewrite every surviving
// row's position (see writePlan on why the whole list rather than a diff).
// The delete runs first so a system that moved out of a position another
// system is about to take can't collide.
const applyWatchList = async (
  { supabase, userId }: Caller,
  before: number[],
  after: number[]
): Promise<string | null> => {
  const plan = writePlan(before, after)
  if (plan.deleted.length > 0) {
    const { error } = await supabase.from('watched_system').delete().eq('user_id', userId).in('system_id', plan.deleted)
    if (error) return `removing the system failed: ${error.message}`
  }
  if (plan.positions.length > 0) {
    const { error } = await supabase.from('watched_system').upsert(
      plan.positions.map(({ systemId, position }) => ({ user_id: userId, system_id: systemId, position })),
      { onConflict: 'user_id,system_id' }
    )
    if (error) return `saving the watch list failed: ${error.message}`
  }
  return null
}

// The list as the reply renders it: index, name, security — what /indexes
// shows down its left-hand column, so a model and the page agree on what the
// numbers mean.
const describeList = async (list: number[]) => {
  const systems = await getSdeSystems(list)
  return list.map((systemId, index) => {
    const sde = systems[systemId]
    return {
      index,
      system: sde?.name ?? `System #${systemId}`,
      system_id: systemId,
      ...(sde && { security: formatSecurity(sde.security), region: sde.regionName }),
    }
  })
}

// `system` takes one name or several. Several only means something to SELECT
// (one row of indexes each); an edit acts on exactly one system, so a list of
// them is refused rather than half-applied.
const asQueries = (system: string | string[] | undefined): string[] =>
  system == null ? [] : (Array.isArray(system) ? system : [system]).map((s) => s.trim()).filter((s) => s !== '')

export const registerWatchedSystemTools = (server: McpServer): void => {
  server.registerTool(
    'edit_watched_systems',
    {
      title: 'Edit watched systems',
      description:
        'Read and edit the ordered list of solar systems this user watches on the /indexes page — the systems industry_cost_indices reports on when none is named, and the ones the industry-systems extract keeps cost-index history for. Four commands: SELECT reports where a system sits in the list (an array of systems answers with one row of indexes each; no system at all lists the whole watch list), INSERT adds a system at an index without removing anything, DELETE removes it from wherever it sits, and UPDATE moves an already-watched system to a new index. The index is where the system ends up: after INSERT or UPDATE at index 2 the system is the third in the list, and everything from there down shifts along. Omit the index to put the system last. Writes: INSERT, DELETE and UPDATE change what this user sees on /indexes and, over time, which systems have index history recorded.',
      annotations: {
        readOnlyHint: false,
        // DELETE removes a row. Trivially undone by re-adding the system, but
        // the cost-index history recorded for it stops accruing, so this is a
        // removal rather than an in-place amendment.
        destructiveHint: true,
        // Every command lands on the same list when repeated: a second INSERT
        // of a watched system is refused, and a second UPDATE to the same index
        // is a no-op.
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        command: z
          .enum(['INSERT', 'DELETE', 'UPDATE', 'SELECT'])
          .describe(
            'INSERT adds a system (refused if already watched — UPDATE is what moves one). DELETE removes it, ignoring the index. UPDATE moves it to the given index, deleting it from its old position first. SELECT only reads.'
          ),
        system: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'The solar system, e.g. "C-J6MT". An array is only meaningful for SELECT, which answers with a row of indexes per system; the writing commands take exactly one. Omit entirely with SELECT to list every watched system.'
          ),
        index: z
          .number()
          .int()
          .optional()
          .describe(
            'Where the system should end up, counting from 0. INSERT at 2 puts it after the systems at 0 and 1 and before the one currently at 2; UPDATE at 2 leaves it third in the resulting list. Omit to put it last. Out-of-range values are pulled to the nearest end. Ignored by DELETE and SELECT.'
          ),
      }),
    },
    async ({ command, system, index }, ctx: ServerCtx): Promise<ToolResult> => {
      const caller = callerFor(ctx)
      if (!caller) return textResult('Missing bearer token.')

      const queries = asQueries(system)
      const before = await fetchWatchList(caller.supabase)

      if (command === 'SELECT') {
        // No system named: the question is "what am I watching".
        if (queries.length === 0) {
          return textResult({
            command,
            watched_systems: await describeList(before),
            ...(before.length === 0 && {
              note: 'Nothing is watched yet. INSERT a system to start recording its cost indices.',
            }),
          })
        }
        const resolved = await Promise.all(queries.map(resolveCandidates))
        const indexes = selectIndexes(
          before,
          resolved.map((r) => r.systemIds)
        )
        const names = await getSdeSystems(before)
        return textResult({
          command,
          // The 2-D answer, one row per system asked about, in the order asked.
          indexes,
          queried: resolved.map((r, i) => ({
            system: r.query,
            indexes: indexes[i],
            watched: indexes[i].map((at) => names[before[at]]?.name ?? `System #${before[at]}`),
            ...(indexes[i].length === 0 && {
              note:
                r.systemIds.length === 0
                  ? `No solar system matched "${r.query}".`
                  : `${r.names[0]} is not on the watch list.`,
            }),
          })),
          watched_systems: await describeList(before),
          ...(index != null && { note: 'SELECT ignores the index.' }),
        })
      }

      if (queries.length === 0) return textResult(`${command} needs a system to act on.`)
      if (queries.length > 1) {
        return textResult(
          `${command} acts on one system at a time; ${queries.length} were given (${queries.join(', ')}). Issue them one at a time — indexes shift as each is applied, so a batch would be ambiguous.`
        )
      }

      const resolved = await resolveOneSystem(queries[0])
      if (!resolved.ok) return textResult(resolved.message)

      const plan = planEdit(before, command, resolved.systemID, index)
      if (!plan.ok) {
        return textResult({
          command,
          system: resolved.name,
          system_id: resolved.systemID,
          changed: false,
          message: plan.message,
          ...(plan.from != null && { index: plan.from }),
          watched_systems: await describeList(before),
        })
      }

      // An UPDATE to the index a system already holds needs no write at all.
      const failure = plan.changed ? await applyWatchList(caller, before, plan.list) : null
      if (failure) return textResult(failure)

      return textResult({
        command,
        system: resolved.name,
        system_id: resolved.systemID,
        changed: plan.changed,
        previous_index: plan.from,
        index: plan.to,
        ...(plan.clamped && {
          clamped: `Index ${plan.requested} is outside the list, so it landed at ${plan.to}.`,
        }),
        ...(plan.note && { note: plan.note }),
        ...(!plan.changed && { note: 'Already at that index — nothing to do.' }),
        watched_systems: await describeList(plan.list),
        cost_indices: 'industry_cost_indices with no system named now covers this list.',
      })
    }
  )
}
