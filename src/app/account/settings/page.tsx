import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { isChancellor } from './chancellor/chancellor'
import { isSsoPlaceholderEmail } from '../lib/ssoEmail'
import ApiToken from './apiToken'
import ChangePassword from './changePassword'
import Discord from './discord'
import { LogoffButton } from './logoffButton'
import MainCharacter from './mainCharacter'

const SettingsPage = async ({ searchParams }: { searchParams: Promise<{ gice?: string }> }) => {
  const { gice: giceParam } = await searchParams
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/account/login')
  }

  const { data: settings } = await supabase.from('user_settings').select('api_token').maybeSingle()
  const { data: characters } = await supabase
    .from('registration')
    .select('id, name, is_main')
    .order('is_main', { ascending: false })
    .order('name', { ascending: true })
  const mainId = characters?.find((c) => c.is_main)?.id ?? null
  const chancellor = await isChancellor(data.user.id)
  const { data: giceAccount } = await supabase.from('gice_account').select('gice_id, name').maybeSingle()
  const placeholderEmail = isSsoPlaceholderEmail(data.user.email)
  const { data: discordChannels } = await supabase
    .from('discord_channel')
    .select('id, guild_id, channel_id, guild_name, channel_name, created_at, disabled_at')
    .order('created_at', { ascending: true })

  return (
    <>
      <h1>Settings</h1>

      <h2>Sign-in methods</h2>
      <p>
        Email:{' '}
        {placeholderEmail ? (
          <>
            none yet — <Link href="/account/email">add an email address</Link>
          </>
        ) : (
          <>
            <strong>{data.user.email}</strong> — <Link href="/account/email">change</Link>
          </>
        )}
      </p>
      <p>
        GICE:{' '}
        {giceAccount ? (
          <>
            linked as <strong>{giceAccount.name ?? `account ${giceAccount.gice_id}`}</strong>
          </>
        ) : (
          <a href="/account/gice">Link your GICE account</a>
        )}
        {giceParam === 'conflict' && ' — that GICE account is already linked to a different Edencom Link account.'}
      </p>

      <ChangePassword />

      <MainCharacter characters={characters ?? []} mainId={mainId} />

      <h2>ESI Access</h2>
      <p>Choose which data we may read from EVE Online when you add a character.</p>
      <Link href="/settings/grants">Manage ESI access</Link>

      <h2>Invite codes</h2>
      <p>Edencom Link is invite-only. See the codes you can give out and when you earn more.</p>
      <Link href="/account/invite">Manage invite codes</Link>

      <Discord appId={process.env.DISCORD_APP_ID ?? null} channels={discordChannels ?? []} />

      <ApiToken initialToken={settings?.api_token ?? null} />

      {chancellor && (
        <>
          <h2>Chancellor</h2>
          <p>
            You have Chancellor powers. Manage who else is a Chancellor, set other accounts&rsquo; feature flags, and
            mint invite codes anytime.
          </p>
          <Link href="/account/settings/chancellor">Chancellor tools</Link>
        </>
      )}

      <h2>Logoff</h2>
      <LogoffButton />
    </>
  )
}

export default SettingsPage
