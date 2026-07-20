// The one route Discord calls into us. Discord signs every interaction with
// Ed25519; we verify the signature (over the raw body, before parsing) and
// answer by interaction type. Stage 2 only handles PING (what the developer
// portal's endpoint validation exercises) — application commands get a
// placeholder ephemeral reply until the command router lands in a later stage.
//
// Node runtime: node:crypto Ed25519 verification (and, later, the service-role
// Supabase client) aren't available on the edge runtime.
import { NextResponse } from 'next/server'

import { recordDiscordInteraction } from '@/observability'

import { EPHEMERAL, InteractionResponseType, InteractionType, verifyDiscordSignature } from '../lib'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  // Verification needs the exact bytes Discord signed, so read the raw text and
  // parse it ourselves — never let the framework consume the body as JSON first.
  const rawBody = await request.text()

  const verified = verifyDiscordSignature({
    rawBody,
    signature: request.headers.get('x-signature-ed25519'),
    timestamp: request.headers.get('x-signature-timestamp'),
    publicKey: process.env.DISCORD_PUBLIC_KEY,
  })
  if (!verified) {
    recordDiscordInteraction({ type: null, outcome: 'bad_signature' })
    return new NextResponse('invalid request signature', { status: 401 })
  }

  // A verified body came from Discord and is always valid JSON; guard anyway so
  // a malformed one is a clean 400 rather than a logged 500.
  let interaction: { type?: number }
  try {
    interaction = JSON.parse(rawBody)
  } catch {
    return new NextResponse('invalid request body', { status: 400 })
  }

  switch (interaction.type) {
    case InteractionType.PING:
      recordDiscordInteraction({ type: interaction.type, outcome: 'pong' })
      return NextResponse.json({ type: InteractionResponseType.PONG })

    case InteractionType.APPLICATION_COMMAND:
      recordDiscordInteraction({ type: interaction.type, outcome: 'unimplemented' })
      return NextResponse.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: EPHEMERAL,
          content: 'Edencom Link is still setting up — commands are not available yet.',
        },
      })

    default:
      recordDiscordInteraction({ type: interaction.type ?? null, outcome: 'unhandled' })
      return NextResponse.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: EPHEMERAL, content: 'Unsupported interaction.' },
      })
  }
}
