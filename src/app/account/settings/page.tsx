// /account/settings — the account control panel (design docs turn 11: grouped
// by direction of data, every panel tagged by how it changes). Four groups:
// identity (who you are), declared inputs (what you've told us), live
// connections (what flows out), administration. Panels read out their current
// value first; editing is an action you take, not a form permanently open.
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { LINK_FLAG, hasFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'

import { getEnabledScopes } from '../../character/userScopes'
import { esiScopes, optionalScopes } from '../../character/scopes'
import { fetchTaxRates, formatRate } from '../../settings/tax/rates'
import { discordAuthEnabled } from '../lib/discordAuth'
import { establishedUser } from '../lib/establishedUser'
import { isSsoPlaceholderEmail } from '../lib/ssoEmail'
import { DiscordButton, DiscordUnlinkButton } from '../discord/button'
import { isChancellor } from './chancellor/chancellor'
import ApiToken from './apiToken'
import ChangePassword from './changePassword'
import Discord from './discord'
import { LogoffButton } from './logoffButton'
import MainCharacter from './mainCharacter'
import styles from './settings.module.css'

const Tag = ({ kind, label }: { kind: string; label: string }) => (
  <span className={`${styles.tag} ${styles[`tag${kind}`]}`}>[ {label} ]</span>
)

const Group = ({ label, note }: { label: string; note?: string }) => (
  <div className={styles.group}>
    <span>{label}</span>
    {note && <span className={styles.groupNote}>{note}</span>}
    <span className={styles.groupRule} />
  </div>
)

const SettingsPage = async ({ searchParams }: { searchParams: Promise<{ gice?: string }> }) => {
  const { gice: giceParam } = await searchParams
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  const { data: settings } = await supabase.from('user_settings').select('api_token').maybeSingle()
  const { data: characters } = await supabase
    .from('registration')
    .select('id, name, character_id, is_main')
    .order('is_main', { ascending: false })
    .order('name', { ascending: true })
  const main = characters?.find((c) => c.is_main) ?? characters?.[0] ?? null
  const chancellor = await isChancellor(user.id)
  const { data: giceAccount } = await supabase.from('gice_account').select('gice_id, name').maybeSingle()
  const placeholderEmail = isSsoPlaceholderEmail(user.email)
  // Which providers this account can sign in with. Supabase owns the list
  // (EVE SSO isn't on it — that's a registration row, not an identity), so ask
  // it rather than inferring from anything of ours.
  const { data: identities } = await supabase.auth.getUserIdentities()
  const discordLinked = (identities?.identities ?? []).some(({ provider }) => provider === 'discord')
  const { data: discordChannels } = await supabase
    .from('discord_channel')
    .select('id, guild_id, channel_id, guild_name, channel_name, created_at, disabled_at')
    .order('created_at', { ascending: true })

  const enabledScopes = await getEnabledScopes(supabase, user.id)
  const rates = await fetchTaxRates(supabase, user.id)
  const { data: inviteCodes } = await supabase.from('invite_code').select('code, redeemed_by')
  const unclaimedCodes = (inviteCodes ?? []).filter((c) => !c.redeemed_by).length

  const optional = esiScopes.filter((s) => !s.required)
  const enabledOptional = optionalScopes.filter((s) => enabledScopes.includes(s))

  // The Discord panel's health dot rolls up the worst linked channel: any
  // channel the bot lost is warn at the header even when others are healthy.
  const channels = discordChannels ?? []
  const discordTone = channels.length === 0 ? null : channels.some((c) => c.disabled_at) ? 'Warn' : 'Good'

  return (
    <>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h1>Account</h1>
          <div className={styles.subtitle}>
            {placeholderEmail ? 'no email yet' : <span className={styles.subtitleStrong}>{user.email}</span>}
            {main && <> · main: {main.name}</>}
            {user.created_at && (
              <>
                {' '}
                · pilot since <span className={styles.mono}>{user.created_at.slice(0, 10)}</span>
              </>
            )}
          </div>
        </div>
        <LogoffButton />
      </div>
      <div className={styles.legend}>
        <span>
          <Tag kind="Credential" label="credential" /> how you get back in
        </span>
        <span>
          <Tag kind="Declared" label="declared" /> changes only when you edit it
        </span>
        <span>
          <Tag kind="Live" label="live" /> moves on its own
        </span>
      </div>

      <Group label="identity" note="who this account is" />
      <div className={styles.grid}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span>Sign-in methods</span>
            <span className={styles.spacer} />
            <Tag kind="Credential" label="credential" />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>email</span>
            <span className={styles.value}>
              {placeholderEmail ? <span className={styles.valueQuiet}>none yet</span> : user.email}
            </span>
            <Link className={styles.act} href="/account/email">
              {placeholderEmail ? 'add' : 'change'}
            </Link>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>password</span>
            <span className={styles.value}>
              <ChangePassword />
            </span>
            <span />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>gice</span>
            <span className={styles.value}>
              {giceAccount ? (
                <>
                  linked as <strong>{giceAccount.name ?? `account ${giceAccount.gice_id}`}</strong>
                </>
              ) : (
                <span className={styles.valueQuiet}>not linked</span>
              )}
              {giceParam === 'conflict' && (
                <span className={styles.badRowNote}>
                  that GICE account is already linked to a different Edencom Link account
                </span>
              )}
            </span>
            {giceAccount ? (
              <span />
            ) : (
              <a className={styles.act} href="/account/gice">
                link
              </a>
            )}
          </div>
          {discordAuthEnabled() && (
            <div className={styles.row}>
              <span className={styles.label}>discord</span>
              <span className={styles.value}>
                {discordLinked ? <strong>linked</strong> : <span className={styles.valueQuiet}>not linked</span>}
              </span>
              <span>
                {discordLinked ? (
                  <DiscordUnlinkButton />
                ) : (
                  <DiscordButton label="link" next="/account/settings" plain />
                )}
              </span>
            </div>
          )}
          <div className={styles.note}>
            At least one of these must stay set — it&apos;s how you get back into everything below.
          </div>
        </div>

        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span>Main character</span>
            <span className={styles.spacer} />
            <Tag kind="Declared" label="declared" />
          </div>
          <MainCharacter
            characters={(characters ?? []).map((c) => ({
              id: c.id,
              name: c.name,
              characterId: c.character_id == null ? null : Number(c.character_id),
            }))}
            mainId={characters?.find((c) => c.is_main)?.id ?? null}
          />
          <div className={styles.note}>
            Represents the account on shared links and the footer sign-off. Every view still covers all{' '}
            {characters?.length ?? 0} characters.
          </div>
        </div>
      </div>

      <Group label="declared inputs" note="changes only when you edit" />
      <div className={styles.grid}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span>ESI grant template</span>
            <span className={styles.spacer} />
            <Tag kind="Declared" label="declared" />
          </div>
          <div className={styles.chips}>
            {optional.map((s) => {
              const on = enabledScopes.includes(s.scope)
              return (
                <span key={s.scope} className={`${styles.chip} ${on ? '' : styles.chipOff}`}>
                  <span className={`${styles.check} ${on ? styles.checkOn : styles.checkOff}`}>{on ? '✓' : ''}</span>
                  {s.name}
                </span>
              )
            })}
          </div>
          <div className={`${styles.row} ${styles.rowSplit}`} style={{ borderTop: '1px solid var(--line-soft)' }}>
            <span className={styles.valueQuiet} style={{ fontSize: '11px' }}>
              <span className={styles.mono}>
                {enabledOptional.length} of {optional.length}
              </span>{' '}
              optional scopes · applies to the next character you register
            </span>
            <Link className={styles.act} href="/account/registrations">
              edit on registrations
            </Link>
          </div>
          <div className={styles.note}>
            Already-registered characters keep the grants they were added with — re-auth a character to upgrade it. The{' '}
            <Link href="/settings/grants">full editor</Link> explains what each scope unlocks.
          </div>
        </div>

        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span>Industry tax rates</span>
            <span className={styles.spacer} />
            <Tag kind="Declared" label="declared" />
          </div>
          <div className={styles.stats}>
            <span className={styles.stat}>
              <span className={styles.statLabel}>your structures</span>
              <span className={styles.statValue}>{formatRate(rates.own)}</span>
              <span className={styles.statNote}>members rate you set in-client</span>
            </span>
            <span className={styles.stat}>
              <span className={styles.statLabel}>public structures</span>
              <span className={styles.statValue}>{formatRate(rates.public)}</span>
              <span className={styles.statNote}>what someone else&apos;s slots charge</span>
            </span>
          </div>
          <div className={`${styles.row} ${styles.rowSplit}`} style={{ borderTop: '1px solid var(--line-soft)' }}>
            <span className={styles.valueQuiet} style={{ fontSize: '11px' }}>
              Declared, not extracted — no ESI endpoint carries structure tax. Structures reports the gap as cost
              avoidance.
            </span>
            <Link className={styles.act} href="/settings/tax">
              edit rates
            </Link>
          </div>
        </div>
      </div>

      <Group label="live connections" note="moves on its own — the dot is current health" />
      <div className={styles.grid}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span>Discord alerts</span>
            {discordTone && <span className={`${styles.dot} ${styles[`dot${discordTone}`]}`} />}
            <span className={styles.spacer} />
            <Tag kind="Live" label="live" />
          </div>
          <Discord appId={process.env.DISCORD_APP_ID ?? null} channels={channels} />
        </div>

        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span>API access — Google Sheets</span>
            {settings?.api_token && <span className={`${styles.dot} ${styles.dotGood}`} />}
            <span className={styles.spacer} />
            <Tag kind="Live" label="live" />
          </div>
          <ApiToken initialToken={settings?.api_token ?? null} linkEnabled={await hasFlag(user.id, LINK_FLAG)} />
        </div>
      </div>

      <Group label="administration" />
      <div className={styles.grid}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span>Invite codes</span>
            <span className={styles.spacer} />
            <Tag kind="Live" label="live" />
          </div>
          <div className={`${styles.row} ${styles.rowSplit}`}>
            <span>
              <span className={styles.mono} style={{ fontSize: '16px' }}>
                {unclaimedCodes}
              </span>{' '}
              <span className={styles.valueQuiet}>unclaimed code{unclaimedCodes === 1 ? '' : 's'}</span>
            </span>
            <Link className={styles.act} href="/account/invite">
              manage codes
            </Link>
          </div>
        </div>

        {chancellor && (
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span>Chancellor</span>
              <span className={styles.spacer} />
              <Tag kind="Elevated" label="elevated" />
            </div>
            <div className={`${styles.row} ${styles.rowSplit}`}>
              <span className={styles.valueQuiet} style={{ fontSize: '11.5px' }}>
                Manage who else is a Chancellor, set other accounts&rsquo; feature flags, and mint invite codes anytime.
              </span>
              <Link className={styles.act} href="/account/settings/chancellor">
                chancellor tools
              </Link>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export default SettingsPage
