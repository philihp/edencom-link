import { LoginForm } from './loginForm'

// Only same-site absolute paths are honored (no scheme-relative `//host` or
// absolute URLs), so `next` can't become an open redirect.
const sanitizeNext = (next: string | undefined): string | undefined =>
  next?.startsWith('/') && !next.startsWith('//') ? next : undefined

const Login = async ({ searchParams }: { searchParams: Promise<{ next?: string }> }) => {
  const { next } = await searchParams
  return <LoginForm next={sanitizeNext(next)} />
}

export default Login
