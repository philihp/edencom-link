// This was taken from https://github.com/MichielvdVelde/eve-sso/tree/master
// however it was having some issues importing node-fetch running node from CLI

import formUrlEncoded from 'form-urlencoded'
import jsonWebToken from 'jsonwebtoken'
import jwksRsa from 'jwks-rsa'

const ENDPOINT = 'https://login.eveonline.com'

class SingleSignOn {
  clientId
  callbackUri
  endpoint
  host
  userAgent
  #authorization
  #jwks
  constructor(clientId, secretKey, callbackUri, { endpoint, userAgent } = {}) {
    this.clientId = clientId
    this.callbackUri = callbackUri
    this.#authorization = Buffer.from(`${clientId}:${secretKey}`).toString('base64')
    this.endpoint = endpoint ?? ENDPOINT
    this.host = new URL(this.endpoint).hostname
    this.userAgent = userAgent ?? `philihp - nodejs@${process.version}`
    this.#jwks = jwksRsa({
      jwksUri: `${this.endpoint}/oauth/jwks`,
      requestHeaders: {
        'User-Agent': this.userAgent,
      },
    })
  }
  getRedirectUrl(state, scopes) {
    let scope = ''
    if (scopes) {
      if (Array.isArray(scopes)) {
        scope = scopes.join(' ')
      } else {
        scope = scopes
      }
    }
    const search = new URLSearchParams({
      response_type: 'code',
      redirect_uri: this.callbackUri,
      client_id: this.clientId,
      scope,
      state,
    })
    return `${this.endpoint}/v2/oauth/authorize?${search.toString()}`
  }
  async getAccessToken(code, isRefreshToken = false) {
    const payload = !isRefreshToken
      ? {
          grant_type: 'authorization_code',
          code,
        }
      : {
          grant_type: 'refresh_token',
          refresh_token: code,
        }
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
    const data = await response.json()
    data.decoded_access_token = await new Promise((resolve, reject) => {
      jsonWebToken.verify(
        data.access_token,
        this.getKey.bind(this),
        {
          issuer: [this.endpoint, this.host],
        },
        (err, decoded) => {
          if (err) return reject(err)
          resolve(decoded)
        }
      )
    })
    return data
  }
  getKey(header, callback) {
    this.#jwks.getSigningKey(header.kid, (err, key) => {
      if (err) return callback(err)
      callback(null, key.getPublicKey())
    })
  }
}
export default SingleSignOn
