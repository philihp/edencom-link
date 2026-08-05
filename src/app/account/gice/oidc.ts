import { createHmac, randomBytes, createHash } from 'node:crypto'

// GICE (Goonfleet's SSO, gice.goonfleet.com) is a standard OpenID Connect
// provider supporting only the authorization code flow. Endpoints are read
// from its discovery document at runtime rather than hardcoded (the issuer
// actually lives on esi.goonfleet.com), cached per server process. Every user
// who passes the flow is a valid Imperium member at the time of login; the
// base `openid` scope is enough for the userinfo claims we read (sub, name,
// pri_grp).

const DISCOVERY_URL = 'https://gice.goonfleet.com/.well-known/openid-configuration'
const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000

export type GiceOidcConfig = {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
}

let cachedConfig: { config: GiceOidcConfig; fetchedAt: number } | null = null

export const giceConfig = async (): Promise<GiceOidcConfig> => {
  if (cachedConfig && Date.now() - cachedConfig.fetchedAt < DISCOVERY_TTL_MS) return cachedConfig.config
  const response = await fetch(DISCOVERY_URL)
  if (!response.ok) throw new Error(`GICE discovery failed: ${response.status}`)
  const config = (await response.json()) as GiceOidcConfig
  if (!config.authorization_endpoint || !config.token_endpoint || !config.userinfo_endpoint) {
    throw new Error('GICE discovery document is missing endpoints')
  }
  cachedConfig = { config, fetchedAt: Date.now() }
  return config
}

// The state cookie holds `<state>:<pkce verifier>`; both are single-use and
// bound to the browser that started the flow.
export const STATE_COOKIE = 'gice_oauth_state'
export const PENDING_COOKIE = 'gice_pending'
export const OAUTH_COOKIE_PATH = '/account/gice'

const base64url = (buffer: Buffer) => buffer.toString('base64url')

export const newOauthState = () => ({
  state: randomBytes(16).toString('hex'),
  verifier: base64url(randomBytes(32)),
})

export const giceAuthorizeUrl = (config: GiceOidcConfig, state: string, verifier: string) => {
  const url = new URL(config.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', process.env.GICE_CLIENT_ID!)
  url.searchParams.set('redirect_uri', process.env.GICE_CALLBACK_URL!)
  url.searchParams.set('scope', 'openid')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()))
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export const exchangeGiceCode = async (config: GiceOidcConfig, code: string, verifier: string) => {
  const basic = Buffer.from(`${process.env.GICE_CLIENT_ID}:${process.env.GICE_SECRET_KEY}`).toString('base64')
  const response = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.GICE_CALLBACK_URL!,
      code_verifier: verifier,
    }),
  })
  if (!response.ok) throw new Error(`GICE token exchange failed: ${response.status}`)
  const json = (await response.json()) as { access_token?: string }
  if (!json.access_token) throw new Error('GICE token exchange returned no access token')
  return json.access_token
}

export type GiceIdentity = {
  giceId: number
  name: string | null
  primaryGroup: string | null
}

// The userinfo endpoint, not the id_token, is the source of claims: the access
// token came straight from the token endpoint over TLS, so its claims are
// authentic without any JWKS/signature plumbing.
export const giceUserinfo = async (config: GiceOidcConfig, accessToken: string): Promise<GiceIdentity> => {
  const response = await fetch(config.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error(`GICE userinfo failed: ${response.status}`)
  const claims = (await response.json()) as { sub?: string | number; name?: string; pri_grp?: string }
  const giceId = Number(claims.sub)
  if (!Number.isInteger(giceId) || giceId <= 0) throw new Error('GICE userinfo returned no usable sub claim')
  return { giceId, name: claims.name ?? null, primaryGroup: claims.pri_grp ?? null }
}

// A verified-but-unregistered GICE identity survives the hop to the invite
// code page as an HMAC-signed short-lived cookie, so the complete step can
// trust it without re-running OAuth. Keyed off the service key — server-only,
// already secret, and rotating it merely invalidates in-flight signups.
const PENDING_TTL_MS = 10 * 60 * 1000

const pendingKey = () => createHash('sha256').update(`gice-pending:${process.env.SUPABASE_SERVICE_KEY}`).digest()

const signPending = (body: string) => base64url(createHmac('sha256', pendingKey()).update(body).digest())

export const encodePendingIdentity = (identity: GiceIdentity) => {
  const body = base64url(Buffer.from(JSON.stringify({ ...identity, exp: Date.now() + PENDING_TTL_MS })))
  return `${body}.${signPending(body)}`
}

export const decodePendingIdentity = (cookie: string | undefined): GiceIdentity | null => {
  if (!cookie) return null
  const [body, signature] = cookie.split('.')
  if (!body || !signature || signPending(body) !== signature) return null
  try {
    const { giceId, name, primaryGroup, exp } = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (typeof exp !== 'number' || exp < Date.now()) return null
    if (!Number.isInteger(giceId) || giceId <= 0) return null
    return { giceId, name: name ?? null, primaryGroup: primaryGroup ?? null }
  } catch {
    return null
  }
}
