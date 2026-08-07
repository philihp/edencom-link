// The deployment's public origin, for absolute URLs built where there is no
// request to read a Host header from.
//
// Every other absolute URL in the app is built in the browser from
// `window.location.origin` (the share dialog, the api_token help text), which
// is exact and needs no configuration. The MCP tools can't do that: a tool call
// arrives over JSON-RPC and the SDK's tool context exposes the verified token
// but not the HTTP request, so a share link has to be assembled from something
// the deployment knows about itself.
//
// Order of trust: an explicit NEXT_PUBLIC_SITE_URL, then Vercel's
// VERCEL_PROJECT_PRODUCTION_URL (set on every deployment and pointing at the
// production domain, unlike VERCEL_URL, which is the per-deployment hostname a
// share link should never be pinned to). When neither is set — local dev — the
// caller gets paths only, which is honest rather than a guessed hostname that
// would produce a dead link.
const normalize = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export const siteOrigin = (): string | null =>
  normalize(process.env.NEXT_PUBLIC_SITE_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '') || null

// A site path as an absolute URL when the origin is known, otherwise the path
// unchanged.
export const siteUrl = (path: string): string => `${siteOrigin() ?? ''}${path}`
