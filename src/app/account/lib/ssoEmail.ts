// Accounts created through an SSO provider (GICE today, Discord soon) have no
// email address of their own, but Supabase Auth requires one — so they get a
// placeholder on a domain that never receives mail. /account/email upgrades a
// placeholder to a real, confirmable address.
export const SSO_EMAIL_DOMAIN = 'sso.edencom.link'

export const giceEmail = (giceId: number) => `gice-${giceId}@${SSO_EMAIL_DOMAIN}`

// An account whose only identity is an EVE character has nothing Supabase can
// address either, and unlike GICE it never passed through admin.createUser — it
// grew out of the anonymous session the character add minted. It gets the same
// kind of placeholder at its first character, for one concrete reason: signing
// somebody back into a passwordless account means minting a magic-link token,
// and that is keyed on an email address. Without one, an account reachable only
// through EVE SSO could never be reached again from a browser that lost its
// cookies (docs/open-registration.md, stage 3).
export const eveEmail = (characterId: number) => `eve-${characterId}@${SSO_EMAIL_DOMAIN}`

export const isSsoPlaceholderEmail = (email: string | undefined | null): boolean =>
  !!email && email.toLowerCase().endsWith(`@${SSO_EMAIL_DOMAIN}`)

// Whether this account still has no address of its own to sign in with: no
// email at all (an account minted anonymously and not yet through a character
// add), or an EVE placeholder — a character token is then the only key to it.
// A GICE placeholder is deliberately not included: that account can always come
// back through GICE. A real address, obviously, is not included either — and
// the domain check is what keeps a genuine `eve-...@somewhere.else` out.
export const needsDurableIdentity = (email: string | undefined | null): boolean =>
  !email || (isSsoPlaceholderEmail(email) && email.trim().toLowerCase().startsWith('eve-'))
