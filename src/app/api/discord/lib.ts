// Shared helpers for the Discord HTTP-interactions endpoint
// (src/app/api/discord/interactions/route.ts). Kept dependency-free — Node's
// built-in crypto verifies Ed25519 natively — so no `discord-interactions`
// package is needed. Later stages (the /edencom command router) reuse the
// constants and the verifier here.
import { createPublicKey, verify } from 'node:crypto'

// Interaction `type` on the inbound payload.
// https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-type
export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const

// Callback `type` on our response.
// https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type
export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const

// Message flag EPHEMERAL (1 << 6): only the invoking user sees the reply.
export const EPHEMERAL = 1 << 6

const hexToBytes = (hex: string): Buffer => Buffer.from(hex, 'hex')

// Discord publishes its application public key in the developer portal as a
// 32-byte hex string. Import it as a raw OKP JWK (no SPKI/DER wrapping) so
// node:crypto can build a verifying KeyObject with zero dependencies.
const publicKeyFrom = (hexKey: string) =>
  createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: hexToBytes(hexKey).toString('base64url') },
    format: 'jwk',
  })

// Verify the X-Signature-Ed25519 header over (timestamp + rawBody), the exact
// message Discord signs. Returns false on any missing/malformed input rather
// than throwing, so the caller answers a clean 401. Discord's endpoint
// validation deliberately sends bad signatures and requires a 401 to pass.
export const verifyDiscordSignature = ({
  rawBody,
  signature,
  timestamp,
  publicKey,
}: {
  rawBody: string
  signature: string | null
  timestamp: string | null
  publicKey: string | undefined
}): boolean => {
  if (!signature || !timestamp || !publicKey) return false
  try {
    const message = Buffer.from(timestamp + rawBody)
    return verify(null, message, publicKeyFrom(publicKey), hexToBytes(signature))
  } catch {
    return false
  }
}
