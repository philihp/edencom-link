import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../lib/establishedUser'

import { LoginForm } from './loginForm'

// Only same-site absolute paths are honored (no scheme-relative `//host` or
// absolute URLs), so `next` can't become an open redirect.
const sanitizeNext = (next: string | undefined): string | undefined =>
  next?.startsWith('/') && !next.startsWith('//') ? next : undefined

const Login = async ({ searchParams }: { searchParams: Promise<{ next?: string }> }) => {
  const { next } = await searchParams
  const sanitizedNext = sanitizeNext(next)

  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (user) {
    redirect(sanitizedNext ?? '/')
  }

  return <LoginForm next={sanitizedNext} />
}

export default Login
