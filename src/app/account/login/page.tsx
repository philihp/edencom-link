import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { discordAuthEnabled } from '../lib/discordAuth'
import { establishedUser } from '../lib/establishedUser'

import { LoginForm } from './loginForm'

// Only same-site absolute paths are honored (no scheme-relative `//host` or
// absolute URLs), so `next` can't become an open redirect.
const sanitizeNext = (next: string | undefined): string | undefined =>
  next?.startsWith('/') && !next.startsWith('//') ? next : undefined

// `discord` carries what the callback route could not say itself: a refused
// consent screen, or an identity already attached to another account.
const DISCORD_NOTES: Record<string, string> = {
  failed: 'That Discord sign-in didn’t complete. You can try again.',
  'linked-elsewhere':
    'That Discord account already belongs to another Edencom Link account. Log in to it first, or use a different Discord account.',
}

const Login = async ({ searchParams }: { searchParams: Promise<{ next?: string; discord?: string }> }) => {
  const { next, discord } = await searchParams
  const sanitizedNext = sanitizeNext(next)

  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (user) {
    redirect(sanitizedNext ?? '/')
  }

  return (
    <LoginForm
      next={sanitizedNext}
      discordEnabled={discordAuthEnabled()}
      discordNote={(discord && DISCORD_NOTES[discord]) || undefined}
    />
  )
}

export default Login
