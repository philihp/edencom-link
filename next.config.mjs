import { withWorkflow } from 'workflow/next'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @eveshipfit/dogma-engine ships a Rust-compiled WASM module (a bundler-style
  // `import * as wasm from "*.wasm"`) for fit statistics. Turbopack (default
  // since Next 16) handles this natively; an explicit empty config just opts
  // in without changing any behavior, per Next's own guidance for this case.
  // (Tried falling back to webpack's asyncWebAssembly path instead — that
  // broke /api/queue/jobs's @vercel/queue route typing, an unrelated
  // pre-existing incompatibility between that route and the webpack build
  // path, so Turbopack is the only viable option here regardless.)
  turbopack: {},
  // The MCP get_skill tool reads this markdown at request time; Next only
  // traces what the bundler sees imported, so without this the deployed
  // function has no copy of the file to read.
  outputFileTracingIncludes: {
    '/api/mcp': ['docs/edencom-industry-SKILL.md'],
  },
  experimental: {
    staleTimes: {
      // How long the client-side router cache may reuse an already-rendered
      // dynamic segment — every page here is dynamic, since they all read a
      // cookie session. The default is 0, meaning a back/forward or a repeat
      // visit re-runs the whole server render, which is why navigating around
      // the asset browser never felt cached.
      //
      // 60s is chosen against what the data can actually do: the extract jobs
      // run every 6 hours, so a page reused within a minute cannot be showing
      // anything a fresh render would have changed. It is deliberately not
      // longer — the header's "Refreshed N minutes ago" freshness indicator
      // rides on these same renders, and a multi-minute cache would let it sit
      // visibly behind an on-demand refresh the user just triggered.
      //
      // (docs/page-load-performance.md originally listed this as a non-goal,
      // on the reasoning that it trades data freshness for navigation speed.
      // That was wrong: at a 6-hourly cadence there is no freshness to trade.)
      dynamic: 60,
    },
  },
  env: {
    // Captured at build time (i.e. when the deployment is built).
    BUILD_TIME: new Date().toISOString(),
    // Vercel exposes the deployed commit sha at build time.
    COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
  },
  // The IMPORTDATA CSV endpoints moved under /api/character/ when the data model
  // was renamed by ESI endpoint. Users' Google Sheets still carry the old URLs
  // (with ?token=...), so keep them working; Sheets follows redirects and Next
  // preserves the query string.
  // edencom.link used to run an ATProto PDS; decommissioned relays/crawlers keep
  // polling /xrpc/<method> forever. This used to be answered by an edge Function
  // (src/app/xrpc/[method]/route.ts), but even a minimal edge Function is a
  // billed invocation — ~1,700/day of pure bot noise. Rewriting to a file under
  // public/ serves the same explanatory body straight from the Edge Network CDN
  // as a static asset: zero Function invocation, and it never appears in runtime
  // logs. `beforeFiles` so it wins before any App Router match. (The only cost of
  // going static is a 200 instead of the old 404; a non-200 with the same
  // zero-compute property would need a Vercel Firewall deny rule instead.)
  rewrites: async () => ({
    beforeFiles: [
      { source: '/xrpc/:method*', destination: '/xrpc-decommissioned.json' },
      // Colon shorthand for Links: a leading `:` stands for `link/`, so
      // /:da204490 is the /link/da204490 viewer and /:da204490/csv is its CSV
      // route. A Link is a URL you hand to someone else, often by voice or in
      // chat, and the truncated id (src/app/link/shortId.ts) already made it
      // short — this makes the prefix short too, without a second identifier
      // to resolve: the shorthand is spelling, not a new name, so every id
      // form the /link routes accept (full uuid or >=8-hex prefix) works here
      // unchanged, and nothing that emits Link URLs has to know about it.
      //
      // `\\:` is path-to-regexp's escape for a literal colon (an unescaped
      // one would open a parameter name). `:rest*` carries whatever follows
      // the id — /csv today — so a later subroute needs no rule of its own;
      // it cannot repeat without its `/` prefix, which is why the id and the
      // remainder are separate parameters rather than one catch-all.
      //
      // A rewrite, not a redirect: the short URL is the point, so it stays in
      // the address bar. `beforeFiles` alongside the entry above (no file or
      // route can begin with a literal colon, so nothing is shadowed).
      { source: '/\\::id/:rest*', destination: '/link/:id/:rest*' },
    ],
    afterFiles: [],
    fallback: [],
  }),
  redirects: async () => [
    { source: '/api/assets', destination: '/api/character/assets', permanent: true },
    { source: '/api/orders', destination: '/api/character/orders', permanent: true },
    { source: '/api/industry', destination: '/api/character/jobs', permanent: true },
    // Characters and the extract-jobs matrix merged into the registrations
    // page under /account (docs/registrations-page). Every generation of the
    // old URLs points straight at the new home rather than chaining through.
    { source: '/characters/refresh', destination: '/account/registrations', permanent: true },
    { source: '/character/refresh', destination: '/account/registrations', permanent: true },
    { source: '/character', destination: '/account/registrations', permanent: true },
    { source: '/jobs', destination: '/account/registrations', permanent: true },
    { source: '/registration', destination: '/account/registrations', permanent: true },
    // The short-lived bare fit view moved when ships got their own page.
    { source: '/asset/:itemId/fit', destination: '/ship/:itemId', permanent: false },
    // /item was where the new fit viewer was dark-launched, then briefly where
    // the eveship.fit embed it replaced went to be retired. Nobody's bookmark
    // should land on a 404 for that (docs/custom-fit-ui.md, stage 4 phase 3).
    { source: '/item/:itemId', destination: '/ship/:itemId', permanent: false },
    // The Chancellor tools became a settings subpage.
    { source: '/account/chancellor', destination: '/account/settings/chancellor', permanent: true },
    // The debug dump and impersonate form folded into the Chancellor tools.
    { source: '/account/debug', destination: '/account/settings/chancellor', permanent: true },
  ],
}

// withWorkflow compiles the 'use workflow'/'use step' directives (see
// src/workflows/) into their orchestrator/step routes.
export default withWorkflow(nextConfig)
