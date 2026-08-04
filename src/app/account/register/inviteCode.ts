// Codes are minted as randomBytes(8).toString('hex') — exactly 16 hex chars.
// Shared by the register form (to gate the live inviter lookup on complete
// input) and the lookup action itself. Lives outside actions.ts because a
// 'use server' module may only export async functions.
export const INVITE_CODE_PATTERN = /^[0-9a-f]{16}$/i
