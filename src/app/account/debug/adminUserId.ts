// One hardcoded operator account may impersonate any other account from
// /account/debug, for support/debugging. No wider admin-role system exists in
// this app yet; this exists to unblock debugging a specific report without
// inventing one. Split into its own module because a 'use server' file may
// only export async functions — a plain constant export there breaks the
// build ("module has no exports at all").
export const ADMIN_USER_ID = '167fa36d-5fb1-4bf0-bdc3-847818971649'
