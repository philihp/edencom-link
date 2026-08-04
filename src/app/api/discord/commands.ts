// The /edencom slash-command router, called by the interactions endpoint after
// signature verification. Runs on the service-role client: the invoker is a
// Discord user, not a signed-in Supabase session, and the link code is what
// proves which account they are — every query here must therefore be scoped
// explicitly (by code, channel, and invoking Discord user), never broadly.
import { createServiceClient } from '@/utils/supabase/service'

import { EPHEMERAL, InteractionResponseType } from './lib'

// The slices of Discord's interaction payload the router reads.
// https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object
type CommandOption = {
  name: string
  value?: string
  options?: CommandOption[]
}
export type CommandInteraction = {
  data?: { name?: string; options?: CommandOption[] }
  guild_id?: string
  channel_id?: string
  guild?: { id?: string; name?: string }
  channel?: { id?: string; name?: string }
  member?: { user?: { id?: string } }
  user?: { id?: string }
}

type CommandResponse = {
  type: number
  data: { flags: number; content: string }
}

const reply = (content: string): CommandResponse => ({
  type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { flags: EPHEMERAL, content },
})

// "#channel-name in Server" when the payload carries names, ids otherwise.
const describeChannel = (interaction: CommandInteraction): string => {
  const channel = interaction.channel?.name ? `#${interaction.channel.name}` : `channel ${interaction.channel_id}`
  const guild = interaction.guild?.name ?? null
  return guild ? `${channel} in ${guild}` : channel
}

const link = async (interaction: CommandInteraction, code: string | undefined): Promise<CommandResponse> => {
  if (!code) return reply('Provide the link code from your edencom.link account settings.')

  const invokerId = interaction.member?.user?.id ?? interaction.user?.id
  if (!invokerId) return reply('Could not tell who ran this command — try again.')

  const supabase = createServiceClient()
  const { data: codeRow, error: codeError } = await supabase
    .from('discord_link_code')
    .select('id, user_id, expires_at, redeemed_at')
    .eq('code', code)
    .maybeSingle()
  if (codeError) return reply('Something went wrong looking up that code — try again.')
  if (!codeRow) return reply('That code is not recognized — generate one from your edencom.link account settings.')
  if (codeRow.redeemed_at) return reply('That code was already used — generate a fresh one from your settings.')
  if (new Date(codeRow.expires_at).getTime() < Date.now())
    return reply('That code has expired (codes last 10 minutes) — generate a fresh one from your settings.')

  const { error: insertError } = await supabase.from('discord_channel').insert({
    user_id: codeRow.user_id,
    guild_id: interaction.guild_id,
    channel_id: interaction.channel_id,
    guild_name: interaction.guild?.name ?? null,
    channel_name: interaction.channel?.name ?? null,
    linked_by_discord_user_id: invokerId,
  })
  // 23505 = unique (user_id, channel_id): this account already targets this
  // channel. Burn the code anyway? No — leave it usable elsewhere; the state
  // the user wanted already exists, so just say so.
  if (insertError?.code === '23505') return reply(`This channel is already linked to that edencom.link account.`)
  if (insertError) return reply('Something went wrong linking the channel — try again.')

  await supabase.from('discord_link_code').update({ redeemed_at: new Date().toISOString() }).eq('id', codeRow.id)

  return reply(
    `Linked! Alerts for that edencom.link account will post to ${describeChannel(interaction)}. Run /edencom unlink here to stop.`
  )
}

const unlink = async (interaction: CommandInteraction): Promise<CommandResponse> => {
  const invokerId = interaction.member?.user?.id ?? interaction.user?.id
  if (!invokerId) return reply('Could not tell who ran this command — try again.')

  // Scope: this channel, links made by this Discord user. Someone else's link
  // to the same channel survives — they (or the account owner via settings)
  // remove their own.
  const supabase = createServiceClient()
  const { data: removed, error } = await supabase
    .from('discord_channel')
    .delete()
    .eq('channel_id', interaction.channel_id)
    .eq('linked_by_discord_user_id', invokerId)
    .select('id')
  if (error) return reply('Something went wrong unlinking — try again.')
  if (!removed?.length)
    return reply('No link of yours found for this channel. Links can also be removed from edencom.link settings.')

  return reply(`Unlinked — ${describeChannel(interaction)} will no longer receive alerts you set up.`)
}

// Route a verified APPLICATION_COMMAND interaction. Unknown commands and
// subcommands get a plain ephemeral note rather than an error, since Discord
// only offers what the registration script registered.
export const handleCommand = async (interaction: CommandInteraction): Promise<CommandResponse> => {
  if (interaction.data?.name !== 'edencom') return reply('Unknown command.')
  if (!interaction.guild_id || !interaction.channel_id)
    return reply('Run this in a server channel that should receive alerts.')

  const subcommand = interaction.data.options?.[0]
  if (subcommand?.name === 'link') {
    const code = subcommand.options?.find((option) => option.name === 'code')?.value
    return link(interaction, code)
  }
  if (subcommand?.name === 'unlink') return unlink(interaction)
  return reply('Unknown subcommand — use /edencom link or /edencom unlink.')
}
