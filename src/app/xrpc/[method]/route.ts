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
import { NextRequest, NextResponse } from 'next/server'

const MESSAGE =
  'This host, edencom.link (including pds.edencom.link) previously ran an ATProto PDS. It might again in the future, but is currently decommissioned; please remove it from your crawl/relay list.'

const swallow = async (request: NextRequest, params: Promise<{ method: string }>) => {
  const { method } = await params
  console.log(`xrpc: rejecting decommissioned-pds request host=${request.headers.get('host')} method=${method}`)
  return NextResponse.json({ error: 'MethodNotImplemented', message: MESSAGE }, { status: 501 })
}

type Context = { params: Promise<{ method: string }> }

export const GET = (request: NextRequest, { params }: Context) => swallow(request, params)
export const POST = (request: NextRequest, { params }: Context) => swallow(request, params)
