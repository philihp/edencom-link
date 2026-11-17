// Guard C8 of docs/ledger/plan.md: a lab script must not run against the
// wrong database. `schema.sql` and the lab load drop and create tables, and
// the census reads whole tables. On production that is a reset or an IO
// spike. So each lab command checks its target first, and refuses any host
// that is not this computer.
//
// Accepted: a URL whose host is localhost, 127.0.0.1 or ::1, and a URL with no
// host that names a Unix socket directory (`postgresql:///lab?host=/tmp`).
// Refused: all else, which includes a URL that does not parse.
import { includes } from 'ramda'

export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']

const parse = (url: string): URL | null => {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

const unbracket = (host: string): string => host.replace(/^\[(.*)\]$/, '$1')

const isSocket = (url: URL): boolean => {
  const socketHost = url.searchParams.get('host')
  return url.hostname === '' && (socketHost === null || socketHost.startsWith('/'))
}

export const isLocalUrl = (url: string | undefined): boolean => {
  const parsed = url ? parse(url) : null
  if (parsed === null) return false
  return isSocket(parsed) || includes(unbracket(parsed.hostname), LOCAL_HOSTS)
}

// The host part only, for an error message: the URL can hold a password.
const hostForMessage = (url: string | undefined): string =>
  url ? (parse(url)?.host ?? 'an unparsable URL') : 'nothing'

// Throws unless `url` is local. `what` names the target in the message.
export const assertLocal = (url: string | undefined, what: string): string => {
  if (!isLocalUrl(url)) {
    throw new Error(
      `refused: ${what} must be a database on this computer (localhost, 127.0.0.1, ::1 or a socket), not ${hostForMessage(url)}`
    )
  }
  return url as string
}
