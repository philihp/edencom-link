// edencom.link (and pds.edencom.link) used to run an AT Protocol PDS. That PDS
// was decommissioned, but relays/crawlers that discovered it keep polling
// well-known XRPC methods (com.atproto.sync.subscribeRepos,
// com.atproto.server.describeServer, ...) indefinitely. Without this route
// those requests fall through to the app's default 404, which renders the
// full root layout (theme resolution, header, footer) for every bot request.
//
// This route answers every /xrpc/<method> request directly, with the
// AT Protocol XRPC error shape a well-behaved client/relay recognizes for an
// unimplemented method, so crawlers can tell this host is no longer a PDS.
// Kept deliberately minimal (edge runtime, no request parsing, no logging,
// a precomputed body) since it exists purely to reject high-volume bot noise
// as cheaply as possible.
export const runtime = 'edge'

// 404 rather than a 5xx: Vercel's function logs flag 5xx responses as errors,
// which would fill the logs with "errors" for what is actually expected,
// working-as-intended bot traffic.
const BODY = JSON.stringify({
  error: 'NotFound',
  message:
    'This host, edencom.link (including pds.edencom.link) previously ran an ATProto PDS. It might again in the future, but is currently decommissioned; please remove it from your crawl/relay list.',
})

const swallow = () => new Response(BODY, { status: 404, headers: { 'content-type': 'application/json' } })

export const GET = swallow
export const POST = swallow
