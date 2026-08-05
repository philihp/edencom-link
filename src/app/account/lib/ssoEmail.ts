// Accounts created through an SSO provider (GICE today, Discord soon) have no
// email address of their own, but Supabase Auth requires one — so they get a
// placeholder on a domain that never receives mail. /account/email upgrades a
// placeholder to a real, confirmable address.
export const SSO_EMAIL_DOMAIN = 'sso.edencom.link'

export const giceEmail = (giceId: number) => `gice-${giceId}@${SSO_EMAIL_DOMAIN}`

export const isSsoPlaceholderEmail = (email: string | undefined | null): boolean =>
  !!email && email.toLowerCase().endsWith(`@${SSO_EMAIL_DOMAIN}`)
