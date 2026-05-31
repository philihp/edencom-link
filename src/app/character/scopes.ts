// Metadata for every ESI OAuth scope we may request when a player adds a
// character. The settings page renders this list so players can choose which
// scopes to grant; `sso.ts` derives the default request set from it and the
// register flow narrows the request to the player's saved preferences.

export type EsiScope = {
  /** The ESI OAuth scope string sent to EVE's SSO. */
  scope: string
  /** Short, human-friendly label for the scope. */
  name: string
  /** Why the app asks for this scope. */
  why: string
  /** What the app cannot do for the character if this scope is declined. */
  without: string
  /** Required scopes are always requested and cannot be turned off. */
  required?: boolean
}

export const esiScopes: EsiScope[] = [
  {
    scope: 'publicData',
    name: 'Public data',
    why: 'Identifies the pilot you are adding (character name and owner hash) so the login can be attached to the right character. This is the minimum EVE requires to complete a login.',
    without: 'we could not tell which character you authorized, so the character cannot be added at all. This scope is required.',
    required: true,
  },
  {
    scope: 'esi-wallet.read_character_wallet.v1',
    name: 'Character wallet',
    why: 'Records this character’s ISK balance over time and their market transaction history.',
    without: 'we cannot show a wallet balance or transaction history for this character.',
  },
  {
    scope: 'esi-assets.read_assets.v1',
    name: 'Character assets',
    why: 'Lists the items and ships this character holds in hangars across New Eden.',
    without: 'this character’s assets, and the locations where they are stored, will not appear on the assets page.',
  },
  {
    scope: 'esi-industry.read_character_jobs.v1',
    name: 'Industry jobs',
    why: 'Tracks this character’s manufacturing, research, invention and reaction jobs, and when they finish.',
    without: 'industry jobs run by this character will not be tracked.',
  },
  {
    scope: 'esi-markets.read_character_orders.v1',
    name: 'Market orders',
    why: 'Shows this character’s open buy and sell orders.',
    without: 'this character’s market orders will not be shown.',
  },
  {
    scope: 'esi-corporations.read_structures.v1',
    name: 'Corporation structures',
    why: 'Monitors your corporation’s Upwell structures, including fuel and reinforcement timers. Requires the Station Manager or Director role in game.',
    without: 'corporation structures and their fuel timers will not be tracked from this character.',
  },
  {
    scope: 'esi-wallet.read_corporation_wallets.v1',
    name: 'Corporation wallet',
    why: 'Reads your corporation’s wallet division journals. Requires the Accountant or Junior Accountant role in game.',
    without: 'corporation wallet journals will not be tracked from this character.',
  },
  {
    scope: 'esi-assets.read_corporation_assets.v1',
    name: 'Corporation assets',
    why: 'Lists corporation assets, which also reveals the rigs fitted to your structures. Requires the Director role in game.',
    without: 'corporation assets and structure fittings will not be tracked from this character.',
  },
  {
    scope: 'esi-universe.read_structures.v1',
    name: 'Structure names',
    why: 'Resolves the names of player-owned Upwell structures where this character keeps assets, so they show a name instead of a raw ID.',
    without: 'player structures where this character holds assets will appear as a numeric ID rather than their name.',
  },
]

/** Every scope, requested by default when a player has saved no preferences. */
export const defaultScopes = esiScopes.map((s) => s.scope)

/** Scopes that are always requested regardless of the player's preferences. */
export const requiredScopes = esiScopes.filter((s) => s.required).map((s) => s.scope)

/** Scopes the player is free to toggle on or off. */
export const optionalScopes = esiScopes.filter((s) => !s.required).map((s) => s.scope)
