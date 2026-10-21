// The Registrations page's "show grants that change things" toggle: whether
// the matrix draws the columns flagged `changes` (changeColumns.ts). Remembered
// in a plain (not httpOnly) cookie so the server render already draws the
// chosen columns — the /indexes productionOnly.ts precedent. Per browser on
// purpose: a view preference, not an account setting.
export const SHOW_CHANGES_COOKIE = 'registrations_show_changes'

// 400 days — the lifetime @supabase/ssr gives the session cookie, and the
// longest a browser will honour (RFC 6265bis caps Max-Age there).
export const SHOW_CHANGES_MAX_AGE = 400 * 24 * 60 * 60

// '1' shows them; absent or anything else hides them.
export const parseShowChanges = (raw: string | undefined): boolean => raw === '1'
