// Session cookies are httpOnly.
//
// A Supabase access token is a bearer JWT — no origin, audience or domain
// claim ties it to this site, and the Data API never inspects Origin or
// Referer. So anything that can read the cookie can replay the session
// against /rest/v1 and /graphql/v1 from anywhere, and the refresh token
// riding in the same payload mints fresh access tokens indefinitely until
// it is revoked. httpOnly takes JS-side theft (XSS, a hostile extension)
// off the table; it does nothing about a user exporting their own token,
// which is harmless anyway since RLS hands them exactly their own rows.
//
// @supabase/ssr cannot default to this, because createBrowserClient reads
// the cookies from document.cookie. This app never runs that client — every
// Supabase call is server-side (the cookie-bound client here, the bearer
// client for MCP, the service client for cron, the anon client for the
// public sde_* mirror), which is why src/utils/supabase/client.ts was
// deleted rather than left dormant. Reintroducing a browser client would
// silently break auth: it would see no session at all. Use the server
// client from a server component or action instead.
//
// Only httpOnly is forced. Everything else — path, sameSite, maxAge,
// secure — is whatever @supabase/ssr computed for that cookie.
export const sessionCookieOptions = <T>(options: T): T & { httpOnly: true } => ({
  ...options,
  httpOnly: true,
})
