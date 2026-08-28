'use client'

import { useEffect, useState } from 'react'

import { generateDiscordLinkCode, removeDiscordChannel, sendDiscordTestMessage } from './actions'
import Dot from './dot'
import styles from './settings.module.css'

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

// The Discord alerts panel body: linked channels as rows with their health,
// then the link-a-channel row (mint a code for /edencom link). Codes live 10
// minutes; the countdown mirrors that client-side so a stale code isn't
// copied in vain.
const Discord = ({ appId, channels }: { appId: string | null; channels: DiscordChannel[] }) => {
  const [code, setCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [response, setResponse] = useState('')
  const [color, setColor] = useState('var(--ink)')

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
      setColor('var(--danger)')
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
      setColor('var(--danger)')
      setResponse(result.error)
      return
    }
    setColor('var(--ok)')
    setResponse('Channel unlinked')
  }

  const test = async (id: string) => {
    setColor('var(--ink)')
    setResponse('Sending…')
    const result = await sendDiscordTestMessage(id)
    if (result.error) {
      setColor('var(--danger)')
      setResponse(result.error)
      return
    }
    setColor('var(--ok)')
    setResponse('Test message sent — check the channel')
  }

  const installUrl = appId
    ? `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`
    : null

  const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`

  return (
    <>
      {channels.map((channel) => (
        <div key={channel.id} className={`${styles.row} ${styles.rowSplit}`}>
          <span className={styles.value}>
            <span>
              {channel.guild_name ?? `server ${channel.guild_id}`} /{' '}
              <b>{channel.channel_name ? `#${channel.channel_name}` : `channel ${channel.channel_id}`}</b>
            </span>
            {channel.disabled_at ? (
              <span className={styles.badRowNote}>bot lost access — remove and re-link</span>
            ) : (
              <span className={styles.rowSub}>linked {channel.created_at.slice(0, 10)}</span>
            )}
          </span>
          <span>
            {!channel.disabled_at && (
              <>
                <button type="button" className={styles.actButton} onClick={() => test(channel.id)}>
                  test
                </button>
                {' · '}
              </>
            )}
            <button
              type="button"
              className={`${styles.actButton} ${styles.dangerAct}`}
              onClick={() => remove(channel.id)}
            >
              remove
            </button>
          </span>
        </div>
      ))}
      <div className={styles.row}>
        <span className={styles.label}>link a channel</span>
        <span className={`${styles.value} ${styles.mono}`} style={{ fontSize: '11px' }}>
          {code ? (
            secondsLeft > 0 ? (
              <>
                {code} <span className={styles.valueQuiet}>· expires {countdown}</span>
              </>
            ) : (
              <span className={styles.valueQuiet}>that code expired — generate another</span>
            )
          ) : (
            <span className={styles.valueQuiet}>—</span>
          )}
        </span>
        <form className={styles.actForm}>
          <button formAction={generate}>generate {code ? 'new ' : ''}code</button>
        </form>
      </div>
      <div className={styles.note}>
        {installUrl ? (
          <a href={installUrl} target="_blank" rel="noreferrer">
            Add the Edencom.link bot to your server
          </a>
        ) : (
          'Add the Edencom.link bot to your server (bot not configured on this deployment)'
        )}
        , then run <code>/edencom link &lt;code&gt;</code> in the channel that should get alerts — Mercenary Den
        reinforcements first.
      </div>
      {response && (
        <div className={styles.feedback}>
          <Dot color={color} response={response} />
        </div>
      )}
    </>
  )
}

export default Discord
