import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Signed share links (sharing layer Revision 3, phase 1 — see
// docs/sharing-layer/01-asset-share-table.md). A link share stores a random
// `secret` on its share row; the URL carries `?share=<signature>` where the
// signature is HMAC-SHA256 over the share id, keyed by the secret concatenated
// with the TOKEN_SALT environment variable. Neither half alone mints a valid
// link: a database dump lacks the salt, the environment lacks the secret.
// Rotating the secret (or nulling it) invalidates every URL ever issued for
// the share; deleting the row revokes everything.
//
// The salt is a parameter rather than read here, so the node test runner can
// exercise signing without env plumbing — callers pass tokenSalt().

export const signShare = (shareId: string, secret: string, salt: string): string =>
  createHmac('sha256', `${secret}${salt}`).update(shareId).digest('base64url')

export const verifyShareToken = (shareId: string, secret: string, salt: string, token: string): boolean => {
  const expected = Buffer.from(signShare(shareId, secret, salt))
  const presented = Buffer.from(token)
  return expected.length === presented.length && timingSafeEqual(expected, presented)
}

// Links minted before the URL cleanup carried the share id ahead of the
// signature — `?share=<shareId>.<signature>` — which for a link repeated the
// id already sitting in the path. Both forms parse; the id half, when present,
// only ever NARROWS the row lookup (a caller rejects a mismatch), it never
// selects a row the URL's own path doesn't already identify. New links carry
// the bare signature, so this exists purely to keep issued URLs working.
export type ParsedShareParam = {
  // The legacy `<shareId>` half, or null for a bare-signature link. An empty
  // string when the param started with the separator — never a valid id, and
  // callers reject it the same way they reject any other mismatch.
  shareId: string | null
  signature: string
}

export const parseShareParam = (param: string): ParsedShareParam => {
  const dot = param.indexOf('.')
  return dot < 0
    ? { shareId: null, signature: param }
    : { shareId: param.slice(0, dot), signature: param.slice(dot + 1) }
}

// The stored private key for a new link share: 32 random bytes, hex.
export const mintShareSecret = (): string => randomBytes(32).toString('hex')

// Env read kept in one place so every caller fails with the same message when
// the deployment is missing its salt (set TOKEN_SALT on Vercel).
export const tokenSalt = (): string => {
  const salt = process.env.TOKEN_SALT
  if (salt === undefined || salt === '') throw new Error('TOKEN_SALT is not set')
  return salt
}
