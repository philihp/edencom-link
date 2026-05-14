// This was taken from https://github.com/MichielvdVelde/eve-sso/tree/master
// however it was having some issues importing node-fetch running node from CLI

import formUrlEncoded from 'form-urlencoded'
import jsonWebToken, { type JwtHeader, type SigningKeyCallback } from 'jsonwebtoken'
import jwksRsa, { type JwksClient } from 'jwks-rsa'

const ENDPOINT = 'https://login.eveonline.com'

export type DecodedAccessToken = {
  scp?: string | string[]
  jti: string
  kid: string
  sub: string
  azp: string
  tenant: string
  tier: string
  region: string
  aud: string | string[]
  name: string
  owner: string
  exp: number
  iat: number
  iss: string
}

export type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  decoded_access_token: DecodedAccessToken
}

export type SsoOptions = {
  endpoint?: string
  userAgent?: string
}

class SingleSignOn {
  clientId: string
  callbackUri: string
  endpoint: string
  host: string
  userAgent: string
  readonly #authorization: string
  readonly #jwks: JwksClient

  constructor(clientId: string, secretKey: string, callbackUri: string, { endpoint, userAgent }: SsoOptions = {}) {
    this.clientId = clientId
    this.callbackUri = callbackUri
    this.#authorization = Buffer.from(`${clientId}:${secretKey}`).toString('base64')
    this.endpoint = endpoint ?? ENDPOINT
    this.host = new URL(this.endpoint).hostname
    this.userAgent = userAgent ?? `philihp - nodejs@${process.version}`
    this.#jwks = jwksRsa({
      jwksUri: `${this.endpoint}/oauth/jwks`,
      requestHeaders: { 'User-Agent': this.userAgent },
    })
  }

  getRedirectUrl(state: string, scopes?: string | string[]): string {
    const scope = Array.isArray(scopes) ? scopes.join(' ') : (scopes ?? '')
    const search = new URLSearchParams({
      response_type: 'code',
      redirect_uri: this.callbackUri,
      client_id: this.clientId,
      scope,
      state,
    })
    return `${this.endpoint}/v2/oauth/authorize?${search.toString()}`
  }

  async getAccessToken(code: string | null, isRefreshToken = false): Promise<TokenResponse> {
    const payload = !isRefreshToken
      ? { grant_type: 'authorization_code', code }
      : { grant_type: 'refresh_token', refresh_token: code }
    const response = await fetch(`${this.endpoint}/v2/oauth/token`, {
      method: 'POST',
      body: formUrlEncoded(payload),
      headers: {
        Host: this.host,
        Authorization: `Basic ${this.#authorization}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
    })
    if (!response.ok) {
      throw new Error(`Got status code ${response.status}`)
    }
    const data = (await response.json()) as Omit<TokenResponse, 'decoded_access_token'>
    const decoded_access_token = await new Promise<DecodedAccessToken>((resolve, reject) => {
      jsonWebToken.verify(
        data.access_token,
        this.getKey.bind(this),
        { issuer: [this.endpoint, this.host] },
        (err, decoded) => {
          if (err) return reject(err)
          resolve(decoded as DecodedAccessToken)
        }
      )
    })
    return { ...data, decoded_access_token }
  }

  private getKey(header: JwtHeader, callback: SigningKeyCallback) {
    this.#jwks.getSigningKey(header.kid, (err, key) => {
      if (err || !key) return callback(err)
      callback(null, key.getPublicKey())
    })
  }
}

export default SingleSignOn
