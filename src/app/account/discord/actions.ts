'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { siteOrigin } from '@/utils/siteUrl'

import { discordAuthEnabled } from '../lib/discordAuth'
import { discordEntryPlan } from '../lib/signupFlow'

// Only same-site absolute paths survive, so `next` can't become an open
// redirect — the same rule /account/login applies to its own.
const sanitizeNext = (next: string): string => (next.startsWith('/') && !next.startsWith('//') ? next : '/')

// Where Discord sends them back. Read from the request rather than configured:
// production and every preview deployment share this code, and the callback has
// to return to whichever host the caller is actually on. (Each of those origins
// still has to be allow-listed in Supabase's Redirect URLs — see
// docs/open-registration.md.) siteOrigin() is the fallback for a context with
// no forwarded host to read.
const callbackUrl = async (next: string): Promise<string> => {
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host')
  const proto = headerList.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https')
  const origin = host ? `${proto}://${host}` : (siteOrigin() ?? '')
  return `${origin}/account/discord/callback?next=${encodeURIComponent(next)}`
}

// Start the Discord round trip, from login, register, or the settings page.
// Returns an error message; on success it redirects out to Discord and never
// returns. Refuses politely when the deployment hasn't enabled the provider —
// the button is hidden then, but a stale form must not 500.
export const startDiscordAuth = async (formData: FormData): Promise<string | undefined> => {
  if (!discordAuthEnabled()) return 'Discord sign-in isn’t enabled here yet.'

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const redirectTo = await callbackUrl(sanitizeNext(`${formData.get('next') ?? '/'}`))

  // Linking converts the account the caller is already holding, instead of
  // minting a second one beside it.
  const { data, error } =
    discordEntryPlan(user ? { userId: user.id } : null) === 'link'
      ? await supabase.auth.linkIdentity({ provider: 'discord', options: { redirectTo, skipBrowserRedirect: true } })
      : await supabase.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo, skipBrowserRedirect: true } })

  if (error || !data?.url) return error?.message ?? 'Could not start a Discord sign-in.'
  redirect(data.url)
}

// Detach Discord from the signed-in account. Supabase refuses to unlink the
// last identity, so an account can't strand itself — and that refusal is worth
// passing through verbatim rather than pre-empting: it knows about identities
// this code doesn't, and an EVE character isn't one of them.
export const unlinkDiscord = async (): Promise<string | undefined> => {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUserIdentities()
  if (error) return error.message

  const identity = data?.identities?.find(({ provider }) => provider === 'discord')
  if (!identity) return 'No Discord account is linked.'

  const { error: unlinkError } = await supabase.auth.unlinkIdentity(identity)
  return unlinkError?.message
}
