'use client'

import { useEffect, useState } from 'react'

import { generateDiscordLinkCode, removeDiscordChannel } from './actions'
import Dot from './dot'

export type DiscordChannel = {
  id: string
  guild_id: string
  channel_id: string
  guild_name: string | null
  channel_name: string | null
  created_at: string
  disabled_at: string | null
}

// Send Messages (1<<11) + Embed Links (1<<14) — the bot asks for nothing else.
const BOT_PERMISSIONS = 2048 + 16384

// The Discord section of settings: install the bot, mint a link code for
// /edencom link, and review/remove linked channels. Codes live 10 minutes; the
// countdown mirrors that client-side so a stale code isn't copied in vain.
const Discord = ({ appId, channels }: { appId: string | null; channels: DiscordChannel[] }) => {
  const [code, setCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('#000000')

  useEffect(() => {
    if (expiresAt === null) return undefined
    const tick = () => setSecondsLeft(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [expiresAt])

  const generate = async () => {
    const result = await generateDiscordLinkCode()
    if (result.error || !result.code || !result.expiresAt) {
      setColor('#FF0000')
      setResponse(result.error ?? 'Could not generate a code')
      return
    }
    setCode(result.code)
    setExpiresAt(new Date(result.expiresAt).getTime())
    setResponse('')
  }

  const remove = async (id: string) => {
    const result = await removeDiscordChannel(id)
    if (result.error) {
      setColor('#FF0000')
      setResponse(result.error)
      return
    }
    setColor('#00AF00')
    setResponse('Channel unlinked')
  }

  const installUrl = appId
    ? `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`
    : null

  const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`

  return (
    <>
      <h2>Discord</h2>
      <p>Get alerts (Mercenary Den reinforcements first) in a Discord channel of your choosing:</p>
      <ol>
        <li>
          {installUrl ? (
            <a href={installUrl} target="_blank" rel="noreferrer">
              Add the Edencom Link bot to your Discord server
            </a>
          ) : (
            'Add the Edencom Link bot to your Discord server (bot not configured on this deployment)'
          )}
        </li>
        <li>Generate a link code below</li>
        <li>
          In the channel that should get alerts, run <code>/edencom link &lt;code&gt;</code>
        </li>
      </ol>
      <form>
        <button formAction={generate}>Generate link code</button>
      </form>
      {code &&
        (secondsLeft > 0 ? (
          <p>
            Your code: <code>{code}</code> — expires in {countdown}
          </p>
        ) : (
          <p>That code expired — generate another.</p>
        ))}

      {channels.length > 0 && (
        <>
          <h3>Linked channels</h3>
          <ul>
            {channels.map((channel) => (
              <li key={channel.id}>
                {channel.guild_name ?? `server ${channel.guild_id}`} /{' '}
                {channel.channel_name ? `#${channel.channel_name}` : `channel ${channel.channel_id}`} — linked{' '}
                {channel.created_at.slice(0, 10)}
                {channel.disabled_at && ' — bot lost access; remove and re-link'}{' '}
                <button onClick={() => remove(channel.id)}>Remove</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p>{response && <Dot color={color} response={response} />}</p>
    </>
  )
}

export default Discord
