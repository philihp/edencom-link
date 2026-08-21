// Whether this deployment offers Discord as a way in (docs/open-registration.md,
// stage 5).
//
// The flow is Supabase Auth's native Discord provider, so the switch that
// actually matters is in the Supabase dashboard, not here — and a button
// pointing at a provider that isn't enabled fails in front of a signed-out
// visitor, which is the one audience least able to make sense of it. So the
// entry points render only when this deployment has been told the dashboard
// side is done. It gates the buttons, not the routes: the actions and the
// callback stay reachable, and refuse politely, so a stale form can't 500.
//
// Split from the env read so `node --test` can exercise the parsing.
export const discordAuthConfigured = (value: string | undefined | null): boolean =>
  /^(1|true|on|yes)$/i.test(`${value ?? ''}`.trim())

export const discordAuthEnabled = (): boolean => discordAuthConfigured(process.env.DISCORD_AUTH)
