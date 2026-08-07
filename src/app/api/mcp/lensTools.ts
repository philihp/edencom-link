// Lens authoring over MCP (docs/sharing-layer/07-lens.md): turn what a human
// asked for in words — "a lens on the container named input showing every type
// that goes into fuel blocks, visible to my corp and to anyone with the URL" —
// into a saved, shared lens.
//
// **These are the first write tools on this server.** Everything else here
// answers questions; `create_lens` inserts a row and, on request, publishes it
// to an audience. Three things keep that narrow:
//
//   * It writes on the caller's own bearer client, so RLS pins the row to them
//     exactly as the web editor's cookie session does. A tool cannot create a
//     lens for someone else, and cannot aim one at an audience the caller isn't
//     in (the ids are matched against their own corporations and alliances).
//   * The query is validated with the same validateLensQuery the editor uses,
//     so a lens saved from here is subject to every rule one saved from the
//     browser is: one operation, one top-level field, no session-only surfaces.
//   * The whole surface sits behind the `lens` dark-launch flag, checked on the
//     caller, the same gate /lens redirects on.
//
// The model is expected to call lens_schema first: it can't write a valid
// query against a schema it hasn't seen, and it can't name an audience without
// knowing which corporations the user is actually in.
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { typeDefs } from '@/app/api/graphql/schema.graphql'
import type { ShareState } from '@/app/asset/shareData'
import { resolveAudience, type AudienceResolution, type OwnAudiences } from '@/app/lens/audience'
import { lensRows } from '@/app/lens/flatten'
import { lensEdits, resolveLensRef } from '@/app/lens/lensRef'
import { runLens } from '@/app/lens/run'
import { applyLensShare, fetchOwnAudiences } from '@/app/lens/share'
import { shortLensId } from '@/app/lens/shortId'
import { parseLensVariables, SESSION_ONLY_ARGUMENTS, SESSION_ONLY_FIELDS, validateLensQuery } from '@/app/lens/validate'
import { LENS_FLAG, hasFlag } from '@/flags'
import { signShare, tokenSalt } from '@/shareToken'
import { createBearerClient } from '@/utils/supabase/bearer'
import { siteUrl } from '@/utils/siteUrl'

import { textResult, type ToolResult } from './lib'

type SupabaseClient = ReturnType<typeof createBearerClient>

// mcp-handler 2.x hands tool callbacks the SDK's ServerContext, where a
// verified token rides under 'http.authInfo'.
type ServerCtx = { http?: { authInfo?: AuthInfo } }

// Both the client (for the RLS-scoped write) and the user id (for the flag
// check and the row's user_id). auth.ts put the verified `sub` in extra.
type Caller = { supabase: SupabaseClient; userId: string }

const callerFor = (ctx: ServerCtx): Caller | null => {
  const token = ctx.http?.authInfo?.token
  const userId = ctx.http?.authInfo?.extra?.userId
  if (!token || typeof userId !== 'string') return null
  return { supabase: createBearerClient(token), userId }
}

// Un-flagging an account turns its lenses off site-wide; the tools say so in
// the same words the editor's redirect implies, since a model needs to be able
// to explain the refusal to the person who asked.
const FLAG_REFUSAL =
  'Lenses are still dark-launched, and this account does not have the "lens" flag. Ask the site owner to enable it before creating one.'

// How much of the lens's own output to hand back after saving. Enough to show
// the human that the query answers what they asked, not enough to make a tool
// result into a data dump — the lens's own page and CSV are where the rows live.
const PREVIEW_ROWS = 5

// Worked examples beat prose for query shape, and these two cover the joints a
// model actually gets wrong: filtering to a container (locationId is the item
// id of the container, which search_assets / browse_assets resolve) and
// filtering to a set of types (typeIds are SDE type ids, as strings).
const EXAMPLES = [
  {
    intent: 'Everything sitting in one container or ship, by its item id.',
    query:
      'query { assets(locationId: "1046809423988", limit: 500) { totalCount truncated rows { itemId typeId typeName quantity locationFlag ownerName } } }',
  },
  {
    intent: 'Only certain item types, wherever they are — e.g. the inputs to a fuel block.',
    query:
      'query { assets(typeIds: ["16273", "17887", "16275", "9832", "44"], limit: 500) { totalCount rows { typeId typeName quantity locationName ownerName } } }',
  },
  {
    intent: 'Both at once: those types, but only inside that container. Variables keep the ids out of the query text.',
    query:
      'query Stock($container: String!, $types: [String!]) { assets(locationId: $container, typeIds: $types, limit: 500) { totalCount rows { typeId typeName quantity } } }',
    variables: { container: '1046809423988', types: ['16273', '17887'] },
  },
]

// The lens's own URLs. Absolute when the deployment knows its origin, paths
// otherwise (see src/utils/siteUrl.ts). `pathId` is the shortest id that
// resolves back to this lens (src/app/lens/shortId.ts) — the URLs carry it,
// while `id` stays the full uuid for anything that needs the exact row.
const lensLinks = (id: string, name: string, pathId: string) => ({
  id,
  name,
  url: siteUrl(`/lens/${pathId}`),
  csv_url: siteUrl(`/lens/${pathId}/csv`),
})

// Who a lens is shared with, in names rather than ids — the answer is read by
// a human through a model, and "KarmaFleet" beats 98000001.
const describeShare = (pathId: string, share: ShareState | null, own: OwnAudiences) => {
  if (!share) {
    return { shared_with_nobody: true, note: 'Saved, but not shared with anyone.' }
  }
  const shareParam = share.shareParam
  return {
    corporations: share.corporationIds.map(
      (id) => own.corporations.find((c) => c.id === id)?.name ?? `Corporation #${id}`
    ),
    alliances: share.allianceIds.map((id) => own.alliances.find((a) => a.id === id)?.name ?? `Alliance #${id}`),
    public: share.isPublic,
    // The signed link is the only URL that works without a session — it's also
    // the one a spreadsheet can pull the CSV from.
    link_url: shareParam ? siteUrl(`/lens/${pathId}?share=${shareParam}`) : null,
    link_csv_url: shareParam ? siteUrl(`/lens/${pathId}/csv?share=${shareParam}`) : null,
  }
}

// Run a query in the caller's own context and describe what came back.
//
// `failed` is the "don't save this" signal: zero rows is a legitimate answer
// (an empty container is still worth watching), but a run that produced no
// data at all means the query is broken in a way validation didn't catch.
const preview = async (userId: string, query: string, variables: Record<string, unknown>) => {
  const result = await runLens({ user_id: userId, query, variables })
  const rows = lensRows(result.data)
  return {
    failed: result.data == null && result.errors.length > 0,
    report: {
      row_count: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      sample: rows.slice(0, PREVIEW_ROWS),
      ...(rows.length > PREVIEW_ROWS && {
        note: `Showing ${PREVIEW_ROWS} of ${rows.length} rows; the lens itself returns all of them.`,
      }),
      ...(result.errors.length > 0 && { errors: result.errors }),
    },
  }
}

// The caller's own lenses. RLS would also surface lenses aimed at them by
// other people, which they can neither edit nor should see listed as theirs —
// hence the explicit user_id filter on top of it.
type LensRow = {
  id: string
  name: string
  query: string
  variables: Record<string, unknown> | null
  enabled: boolean
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
  updated_at: string
}

const fetchOwnLenses = async (supabase: SupabaseClient, userId: string): Promise<LensRow[]> => {
  const { data } = await supabase
    .from('lens')
    .select('id, name, query, variables, enabled, corporation_ids, alliance_ids, secret, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
  return (data ?? []) as LensRow[]
}

// A stored row's audience in the same shape applyLensShare hands back, so a
// listing and a just-written lens describe sharing identically. The signature
// is recomputed rather than stored — it's an HMAC over the id, keyed by the
// row's secret and the env-only salt.
const storedShare = (row: LensRow): ShareState | null => {
  if (!row.enabled) return null
  let salt: string | null = null
  if (row.secret) {
    try {
      salt = tokenSalt()
    } catch {
      salt = null
    }
  }
  return {
    corporationIds: row.corporation_ids ?? [],
    allianceIds: row.alliance_ids ?? [],
    hasLink: row.secret != null,
    shareParam: row.secret && salt ? signShare(row.id, row.secret, salt) : null,
    isPublic: row.secret == null && (row.corporation_ids ?? []).length === 0 && (row.alliance_ids ?? []).length === 0,
  }
}

const RULES = [
  'Exactly one operation, and it must be a query.',
  'Exactly one top-level field, so the CSV rendering has an unambiguous primary list.',
  `No session-only surfaces: the ${SESSION_ONLY_FIELDS.map((f) => `"${f}"`).join(', ')} field${
    SESSION_ONLY_FIELDS.length === 1 ? '' : 's'
  } and the ${SESSION_ONLY_ARGUMENTS.map((a) => `"${a}"`).join(', ')} argument are rejected — a lens already runs as its creator.`,
  'Variables are fixed by the creator when the lens is saved; whoever opens the lens cannot change them.',
  'A lens reads current data only. There is no history in this schema.',
]

export const registerLensTools = (server: McpServer): void => {
  server.registerTool(
    'lens_schema',
    {
      title: 'Lens schema and audiences',
      description:
        'What you need before calling create_lens: the GraphQL schema a lens query is written against, the rules a lens query must satisfy, worked example queries, and the audiences this user can share a lens with (the corporations and alliances their characters are actually in). Call this first — a lens query written against a guessed schema will be rejected at save time, and an audience the user is not in cannot be named.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (_args, ctx: ServerCtx): Promise<ToolResult> => {
      const caller = callerFor(ctx)
      if (!caller) return textResult('Missing bearer token.')
      if (!(await hasFlag(caller.userId, LENS_FLAG))) return textResult(FLAG_REFUSAL)

      const own = await fetchOwnAudiences(caller.supabase)
      return textResult({
        what_a_lens_is:
          "A saved GraphQL query over the creator's own data. Whoever it is shared with runs it and sees the creator's results — they never gain access to the underlying data, and they cannot change the query or its variables.",
        rules: RULES,
        examples: EXAMPLES,
        schema: typeDefs,
        audiences: {
          corporations: own.corporations,
          alliances: own.alliances,
          note: 'A lens can be shared with any of these, and/or as a signed link that works for anyone holding the URL, or made fully public. Nothing else — you cannot aim a lens at a corporation this user is not in.',
        },
      })
    }
  )

  server.registerTool(
    'create_lens',
    {
      title: 'Create a lens',
      description:
        "Save a GraphQL query as a lens over this user's data, and optionally share it. Call lens_schema first for the schema, the rules and this user's shareable audiences; use the read tools (search_assets, browse_assets, blueprint_for_product) to turn what the human described into the concrete item ids and type ids the query needs. Writes: this creates a row owned by the calling user, and sharing it makes the query's results visible to whoever it names. Returns the lens URL, the CSV URL for spreadsheets, the signed share link when one was asked for, and a preview of what the lens currently returns so you can check it answers the question. Editing and deleting a lens are done in the web editor at /lens.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        name: z.string().min(1).describe('What the lens is called, e.g. "Fuel block inputs in the input container".'),
        query: z
          .string()
          .min(1)
          .describe('The GraphQL query, valid against the schema lens_schema returns. One query, one top-level field.'),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Values for the query\'s variables, e.g. { "container": "1046809423988" }. Fixed at save time.'),
        share_with_corporations: z
          .array(z.string())
          .optional()
          .describe(
            'Corporations to share with, by name or id — must be ones this user is in (see lens_schema). "my corp" resolves when there is only one.'
          ),
        share_with_alliances: z
          .array(z.string())
          .optional()
          .describe('Alliances to share with, by name or id — must be ones this user is in.'),
        share_link: z
          .boolean()
          .optional()
          .describe(
            'Mint a signed URL that works for anyone holding it, signed in or not. This is what "anyone with the link" means, and what Google Sheets IMPORTDATA needs.'
          ),
        share_public: z
          .boolean()
          .optional()
          .describe(
            'Visible to everyone, no link needed. Mutually exclusive with the corporation, alliance and link options — do not set it just to mean "shared".'
          ),
      }),
    },
    async (
      { name, query, variables, share_with_corporations, share_with_alliances, share_link, share_public },
      ctx: ServerCtx
    ): Promise<ToolResult> => {
      const caller = callerFor(ctx)
      if (!caller) return textResult('Missing bearer token.')
      if (!(await hasFlag(caller.userId, LENS_FLAG))) return textResult(FLAG_REFUSAL)

      // Everything that can be rejected is rejected before anything is written:
      // a half-created lens (saved but unshareable) is worse than a refusal.
      const validation = validateLensQuery(query)
      if (!validation.ok) {
        return textResult(`${validation.message} Call lens_schema for the schema this query has to satisfy.`)
      }
      const parsedVariables = parseLensVariables(variables ? JSON.stringify(variables) : '')
      if (!parsedVariables.ok) return textResult(parsedVariables.message)

      const own = await fetchOwnAudiences(caller.supabase)
      const resolved = resolveAudience(
        {
          corporations: share_with_corporations,
          alliances: share_with_alliances,
          link: share_link,
          isPublic: share_public,
        },
        own
      )
      if (!resolved.ok) return textResult(resolved.message)

      // Run it as the creator (which is the caller) BEFORE saving anything, so
      // a query that only fails at run time leaves no row behind for someone to
      // clean up. Nothing is persisted by running — this is what the editor's
      // Run-as-me preview does, in the same context the viewer builds.
      const preflight = await preview(caller.userId, query, parsedVariables.variables)
      if (preflight.failed) {
        return textResult({
          saved: false,
          error: 'Nothing was created: running this query returned no data at all.',
          preview: preflight.report,
        })
      }

      const { data: inserted, error } = await caller.supabase
        .from('lens')
        .insert({
          user_id: caller.userId,
          name: name.trim(),
          query,
          variables: parsedVariables.variables,
          updated_at: new Date().toISOString(),
        })
        .select('id')
        .maybeSingle<{ id: string }>()
      if (error || !inserted)
        return textResult(`Could not save the lens: ${error?.message ?? 'insert returned no row'}`)
      const pathId = await shortLensId(inserted.id)

      const applied = await applyLensShare(caller.supabase, caller.userId, inserted.id, resolved.audience, {
        existingSecret: null,
      })
      // The lens exists either way — say so rather than implying nothing
      // happened, or the model will try again and leave a duplicate behind.
      if (!applied.ok) {
        return textResult({
          lens: lensLinks(inserted.id, name.trim(), pathId),
          shared: false,
          preview: preflight.report,
          warning: `The lens was saved but could not be shared: ${applied.message} Set the audience in the web editor at /lens.`,
        })
      }

      return textResult({
        lens: lensLinks(inserted.id, name.trim(), pathId),
        share: describeShare(pathId, applied.share, own),
        preview: preflight.report,
      })
    }
  )

  server.registerTool(
    'list_lenses',
    {
      title: 'List your lenses',
      description:
        'The lenses this user has saved: name, id, the stored query and variables, who each is shared with, and its URLs (including the signed link where one exists). Call this before update_lens to find the lens being talked about, or to answer "what lenses do I have" and "what\'s the link for my fuel lens again". Lists only lenses this user created — a lens someone else shared with them isn\'t theirs to edit.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        include_query: z
          .boolean()
          .optional()
          .describe("Include each lens's full GraphQL query text (default true). Turn off for a shorter list."),
      }),
    },
    async ({ include_query }, ctx: ServerCtx): Promise<ToolResult> => {
      const caller = callerFor(ctx)
      if (!caller) return textResult('Missing bearer token.')
      if (!(await hasFlag(caller.userId, LENS_FLAG))) return textResult(FLAG_REFUSAL)

      const [rows, own] = await Promise.all([
        fetchOwnLenses(caller.supabase, caller.userId),
        fetchOwnAudiences(caller.supabase),
      ])
      const pathIds = await Promise.all(rows.map((row) => shortLensId(row.id)))

      return textResult({
        lenses: rows.map((row, i) => ({
          ...lensLinks(row.id, row.name, pathIds[i]),
          updated_at: row.updated_at,
          share: describeShare(pathIds[i], storedShare(row), own),
          ...(include_query === false
            ? {}
            : {
                query: row.query,
                ...(row.variables && Object.keys(row.variables).length > 0 && { variables: row.variables }),
              }),
        })),
        ...(rows.length === 0 && { note: 'No lenses yet. create_lens makes one.' }),
      })
    }
  )

  server.registerTool(
    'update_lens',
    {
      title: 'Update a lens',
      description:
        "Change an existing lens: its name, its query, its variables, who it's shared with, or any combination. Anything not given is left alone, so renaming a lens doesn't touch its query and re-sharing it doesn't touch either. Identify the lens by id or by name (list_lenses shows both). Writes: this changes what the lens's existing audience sees the next time they open it. A new query is run before it is saved, so a broken one is refused rather than pushed to that audience. Deleting a lens is done in the web editor at /lens.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        lens: z.string().min(1).describe('Which lens — its id, or its name as saved (see list_lenses).'),
        name: z.string().optional().describe('Rename it.'),
        query: z
          .string()
          .optional()
          .describe('Replace the GraphQL query. Same rules as create_lens; call lens_schema if unsure.'),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Replace the variables wholesale (not merged with the stored ones).'),
        share_with_corporations: z
          .array(z.string())
          .optional()
          .describe(
            'Replace the corporation audience. Naming any share_* option replaces the whole audience — list every corporation, alliance and link the lens should end up with, not just the additions.'
          ),
        share_with_alliances: z.array(z.string()).optional().describe('Replace the alliance audience.'),
        share_link: z.boolean().optional().describe('Whether a signed link works. False removes the existing link.'),
        share_public: z
          .boolean()
          .optional()
          .describe('Make it visible to everyone. Mutually exclusive with the corporation, alliance and link options.'),
        rotate_link: z
          .boolean()
          .optional()
          .describe('Mint a fresh signed link, invalidating every URL previously issued for this lens.'),
        unshare: z
          .boolean()
          .optional()
          .describe('Stop sharing entirely — back to private, not public. Overrides the other share options.'),
      }),
    },
    async (args, ctx: ServerCtx): Promise<ToolResult> => {
      const caller = callerFor(ctx)
      if (!caller) return textResult('Missing bearer token.')
      if (!(await hasFlag(caller.userId, LENS_FLAG))) return textResult(FLAG_REFUSAL)

      const rows = await fetchOwnLenses(caller.supabase, caller.userId)
      if (rows.length === 0) return textResult('You have no lenses to update. create_lens makes one.')
      const picked = resolveLensRef(args.lens, rows)
      if (!picked.ok) return textResult(picked.message)
      const stored = rows.find((r) => r.id === picked.id) as LensRow
      const pathId = await shortLensId(stored.id)

      // What the edit actually changes, and what the lens will run afterwards —
      // which is the stored query when only the audience is being touched.
      const edits = lensEdits(
        { name: args.name, query: args.query, variables: args.variables },
        { query: stored.query, variables: stored.variables ?? {} }
      )
      if (edits.changes.query !== undefined) {
        const validation = validateLensQuery(edits.changes.query)
        if (!validation.ok) {
          return textResult(`${validation.message} Call lens_schema for the schema this query has to satisfy.`)
        }
      }

      // Sharing is only touched when the call says something about it —
      // otherwise a rename would quietly unshare the lens.
      const shareRequested =
        args.unshare === true ||
        args.share_public !== undefined ||
        args.share_link !== undefined ||
        args.share_with_corporations !== undefined ||
        args.share_with_alliances !== undefined ||
        args.rotate_link === true

      const own = await fetchOwnAudiences(caller.supabase)
      const resolved: AudienceResolution = args.unshare
        ? { ok: true, audience: { corporationIds: [], allianceIds: [], link: false, isPublic: false, shared: false } }
        : resolveAudience(
            {
              corporations: args.share_with_corporations,
              alliances: args.share_with_alliances,
              // An unmentioned link survives a re-share; false removes it.
              link: args.share_link ?? stored.secret != null,
              isPublic: args.share_public,
            },
            own
          )
      if (!resolved.ok) return textResult(resolved.message)

      // Run the query the lens will have BEFORE writing it, so an audience that
      // already has this lens never sees a broken one — the existing row stays
      // exactly as it was.
      const preflight = await preview(caller.userId, edits.effective.query, edits.effective.variables)
      if (preflight.failed) {
        return textResult({
          updated: false,
          error: 'Nothing was changed: running the query this lens would have returned no data at all.',
          lens: lensLinks(stored.id, stored.name, pathId),
          preview: preflight.report,
        })
      }

      if (edits.changed.length > 0) {
        const { error } = await caller.supabase
          .from('lens')
          .update({ ...edits.changes, updated_at: new Date().toISOString() })
          .eq('id', stored.id)
          .eq('user_id', caller.userId)
        if (error) return textResult(`Could not update the lens: ${error.message}`)
      }

      const applied = shareRequested
        ? await applyLensShare(caller.supabase, caller.userId, stored.id, resolved.audience, {
            existingSecret: stored.secret,
            rotateLink: args.rotate_link === true,
          })
        : ({ ok: true, share: storedShare(stored) } as const)
      if (!applied.ok) {
        return textResult({
          lens: lensLinks(stored.id, edits.changes.name ?? stored.name, pathId),
          changed: edits.changed,
          warning: `The lens was updated but its sharing could not be changed: ${applied.message}`,
          preview: preflight.report,
        })
      }

      return textResult({
        lens: lensLinks(stored.id, edits.changes.name ?? stored.name, pathId),
        changed: [...edits.changed, ...(shareRequested ? ['share'] : [])],
        ...(edits.changed.length === 0 && !shareRequested && { note: 'Nothing to change — no fields were given.' }),
        share: describeShare(pathId, applied.share, own),
        preview: preflight.report,
      })
    }
  )
}
