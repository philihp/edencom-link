// What a Chancellor typed into the Impersonate box, and which account it
// names. Pure: the action does the lookups, this decides what to look up and
// what a lookup's answer means. Tested in test/impersonationTarget.test.ts.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ImpersonationTarget =
  | { kind: 'empty' }
  // A Supabase user id, pasted from the debug dump or a log.
  | { kind: 'user'; userId: string }
  // Anything else is read as a character name: EVE names are unique, so one
  // name is one character, and a character is linked to one account.
  | { kind: 'character'; name: string }

export const parseImpersonationTarget = (raw: string): ImpersonationTarget => {
  const input = raw.trim().replace(/\s+/g, ' ')
  if (input === '') return { kind: 'empty' }
  if (UUID_RE.test(input)) return { kind: 'user', userId: input.toLowerCase() }
  return { kind: 'character', name: input }
}

// The account a character-name lookup settles on: the rows are every
// registration whose name matched, and the answer is their one owner. Two
// owners is a refusal, not a guess — a name pasted with a stray wildcard, or
// a character re-registered on a second account, must not land the
// Chancellor in whichever account sorted first.
export const ownerOfMatches = (
  rows: ReadonlyArray<{ user_id: string | null }>
): { ok: true; userId: string } | { ok: false; reason: 'none' | 'ambiguous' } => {
  const owners = new Set(rows.flatMap((row) => (row.user_id ? [row.user_id] : [])))
  if (owners.size === 0) return { ok: false, reason: 'none' }
  if (owners.size > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, userId: [...owners][0] }
}
