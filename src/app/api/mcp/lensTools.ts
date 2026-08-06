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
import { resolveAudience } from '@/app/lens/audience'
import { lensRows } from '@/app/lens/flatten'
import { runLens } from '@/app/lens/run'
import { applyLensShare, fetchOwnAudiences } from '@/app/lens/share'
import { parseLensVariables, SESSION_ONLY_ARGUMENTS, SESSION_ONLY_FIELDS, validateLensQuery } from '@/app/lens/validate'
import { LENS_FLAG, hasFlag } from '@/flags'
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

      // Run it as the creator (which is the caller) before publishing it, so
      // the answer shows what the audience will actually see and a query that
      // only fails at run time never reaches an audience. Same context the
      // viewer page builds — previewing widens no access.
      const result = await runLens({
        user_id: caller.userId,
        query,
        variables: parsedVariables.variables,
      })
      const rows = lensRows(result.data)
      const preview = {
        row_count: rows.length,
        columns: rows.length > 0 ? Object.keys(rows[0]) : [],
        sample: rows.slice(0, PREVIEW_ROWS),
        ...(rows.length > PREVIEW_ROWS && {
          note: `Showing ${PREVIEW_ROWS} of ${rows.length} rows; the lens itself returns all of them.`,
        }),
        ...(result.errors.length > 0 && { errors: result.errors }),
      }
      // Zero rows is a legitimate answer (an empty container is still worth
      // watching); a run that produced nothing at all is not, so that one is
      // saved unshared rather than published broken.
      const failedOutright = result.data == null && result.errors.length > 0

      const applied = failedOutright
        ? ({ ok: true, share: null } as const)
        : await applyLensShare(caller.supabase, caller.userId, inserted.id, resolved.audience, {
            existingSecret: null,
          })
      // The lens exists either way — say so rather than implying nothing
      // happened, or the model will try again and leave a duplicate behind.
      if (!applied.ok) {
        return textResult({
          lens: { id: inserted.id, name: name.trim(), url: siteUrl(`/lens/${inserted.id}`) },
          shared: false,
          preview,
          warning: `The lens was saved but could not be shared: ${applied.message} Set the audience in the web editor at /lens.`,
        })
      }
      if (failedOutright) {
        return textResult({
          lens: { id: inserted.id, name: name.trim(), url: siteUrl(`/lens/${inserted.id}`) },
          shared: false,
          preview,
          warning:
            'The lens was saved but NOT shared: running it returned no data. Fix or delete it in the web editor at /lens rather than creating another.',
        })
      }

      const share = applied.share
      const shareParam = share?.shareParam ?? null
      return textResult({
        lens: {
          id: inserted.id,
          name: name.trim(),
          url: siteUrl(`/lens/${inserted.id}`),
          csv_url: siteUrl(`/lens/${inserted.id}/csv`),
        },
        share: share
          ? {
              corporations: share.corporationIds.map(
                (id) => own.corporations.find((c) => c.id === id)?.name ?? `Corporation #${id}`
              ),
              alliances: share.allianceIds.map(
                (id) => own.alliances.find((a) => a.id === id)?.name ?? `Alliance #${id}`
              ),
              public: share.isPublic,
              // The signed link is the only URL that works without a session —
              // it's also the one a spreadsheet can pull the CSV from.
              link_url: shareParam ? siteUrl(`/lens/${inserted.id}?share=${shareParam}`) : null,
              link_csv_url: shareParam ? siteUrl(`/lens/${inserted.id}/csv?share=${shareParam}`) : null,
            }
          : { shared_with_nobody: true, note: 'Saved, but not shared. Share it from the web editor at /lens.' },
        preview,
      })
    }
  )
}
