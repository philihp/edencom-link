# Server-Timing headers

Every request-serving surface that does real backend work now answers with a
`Server-Timing` header breaking that work down, so the browser's network panel
(Chrome/Edge devtools → Network → Timing) shows _which_ query made a response
slow instead of only that it was.

```
Server-Timing: total;dur=215.1, db.character_asset_snapshot_at;dur=123.3,
               db.user_settings;dur=44.4, db.registration;dur=43.6
```

It complements, and does not replace, the `request.timing` metric line
(`src/observability.js`): that one is for aggregate p50/p95 over days in Vercel
Observability; this one is for the single request you are looking at right now.
Same clock, different audience.

## How it works

`src/serverTiming.ts` holds a request-scoped span collector in an
`AsyncLocalStorage`. A route handler opens the scope; anything it awaits — five
frames down, through code that knows nothing about timing — can contribute a
span. Outside a scope every entry point is a no-op costing one storage lookup,
which is what happens during a page render, a cron job, or a workflow step.

Spans arrive two ways:

1. **Automatically, per Supabase round trip.** Each client factory under
   `src/utils/supabase/` passes `timedSupabaseFetch(label)` as supabase-js's
   `global.fetch` (`src/utils/supabase/timedFetch.ts`). That one function sees
   both the URL and the clock, so it names the span from the path:
   `db.<rpc-or-table>` for the caller-scoped clients (cookie session, service
   role, MCP bearer), `sde.<rpc-or-table>` for the public SDE mirror, `auth.*`
   for GoTrue. This is where the time goes on nearly every surface here —
   `docs/page-load-performance.md`'s measurement found a single RPC accounting
   for 3.2 s — so it is worth having without touching a call site.
2. **Explicitly**, wrapping anything else worth naming in `timed(name, fn)`:
   `appraise.price` (the innomin.at call, which blocks on a global throttle
   queue), `appraise.walk`, `graphql.context` / `graphql.execute`,
   `link.context` / `link.execute`.

Repeats of a name fold into one metric carrying a count (`db.link;dur=88;desc="4×"`),
durations are summed, the list is sorted slowest-first, and anything past 24
distinct metrics folds into one `other` entry — a header a proxy drops shows
nothing at all. `total` always leads.

## Where the header appears

- Everything wrapped by `withRequestTiming` (`src/app/api/requestTiming.ts`) —
  the api_token CSV routes under `/api/character/*` and `/api/corp/*`, and
  `/sheets/market/[market]`. The wrapper opens the scope, so no route needed
  changing.
- `/link/[id]/csv`, `/api/graphql`, `/api/appraisal`, `/api/type/search` —
  each opts in with `withServerTiming(handler)`.

Two deliberate omissions:

**Publicly cacheable responses go unstamped.** A response carrying `public` or
`s-maxage` is served to later callers unchanged, header included, so stamping
it would hand everybody after the first the first request's timing dressed up
as their own. `/sheets/market/[market]`'s CDN entry lives up to a week. The
`request.timing` metric still covers those.

**Pages carry no header, and can't.** App Router server components have no
access to the response — there is no supported API for setting a header from a
page render, and middleware (`src/proxy.ts`) runs before the render, when there
is nothing to report yet. This is the frustrating half: the heaviest work in
this app is on pages like `/asset/[locationId]`. The instrumentation is still
live under those renders (it just finds no scope and does nothing); if Next
ever grows a response-header seam for pages, wrapping the render in
`collectServerTiming` is the whole change. Until then, page timing is measured
the way `docs/page-load-performance.md` measured it: `EXPLAIN ANALYZE` and
Vercel Observability.

## Adding a span

```ts
import { timed } from '@/serverTiming'

const rows = await timed('structure.fuel', () => computeFuelState(structures))
```

Name it `<area>.<thing>`; the serializer will sanitize anything that isn't an
RFC 9110 token character, but a name that needed sanitizing reads badly. Keep
the vocabulary small — a name per row would blow past the metric cap.

To put the header on a route that doesn't have it yet, wrap the exported
handler: `export const GET = withServerTiming(handler)`.

## Caveat: node:async_hooks

`src/serverTiming.ts` imports `node:async_hooks`, which has no browser
counterpart — so any client component that transitively imports a Supabase
client factory is now a hard build error rather than a silent oversize bundle.
One existed: the Chancellor flag form imported `KNOWN_FLAGS` from `@/flags`,
which imports the service-role client. The flag vocabulary moved to the
dependency-free `src/flagCatalog.ts` (re-exported from `@/flags`, so server
callers are unchanged). If a future build fails this way, the fix is the same
shape: split the constants out, don't reach for a bundler alias.
