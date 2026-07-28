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
    without:
      'we could not tell which character you authorized, so the character cannot be added at all. This scope is required.',
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
    scope: 'esi-characters.read_blueprints.v1',
    name: 'Character blueprints',
    why: 'Lists this character’s blueprints — original or copy, and their research level (ME/TE) and remaining runs.',
    without: 'this character’s blueprints will not be tracked.',
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
    scope: 'esi-corporations.read_blueprints.v1',
    name: 'Corporation blueprints',
    why: 'Lists your corporation’s blueprints — original or copy, and their research level (ME/TE) and remaining runs. Requires the Director role in game.',
    without: 'corporation blueprints will not be tracked from this character.',
  },
  {
    scope: 'esi-industry.read_corporation_jobs.v1',
    name: 'Corporation industry jobs',
    why: 'Tracks your corporation’s manufacturing, research, invention and reaction jobs, and when they finish. Requires the Factory Manager role in game.',
    without: 'industry jobs run against corporation blueprints or facilities will not be tracked.',
  },
  {
    scope: 'esi-location.read_location.v1',
    name: 'Character location',
    why: 'Shows the solar system this character is currently in.',
    without: 'this character’s current location will not be shown.',
  },
  {
    scope: 'esi-clones.read_clones.v1',
    name: 'Character clones',
    why: 'Lists this character’s home clone and jump clones, the systems they sit in, and the implants installed in each.',
    without: 'this character’s clones and the implants in them will not be tracked.',
  },
  {
    scope: 'esi-clones.read_implants.v1',
    name: 'Character implants',
    why: 'Lists the implants currently plugged into this character.',
    without: 'this character’s currently active implants will not be shown.',
  },
  {
    scope: 'esi-skills.read_skills.v1',
    name: 'Character skills',
    why: 'Reads this character’s trained skill levels, used to show how many parallel manufacturing, research, and reaction jobs they can run.',
    without:
      'this character’s industry job-slot capacity will fall back to the untrained minimum of one slot per activity.',
  },
  {
    scope: 'esi-location.read_ship_type.v1',
    name: 'Character current ship',
    why: 'Identifies the ship this character is currently in, so it can be excluded from the asset listing at wherever the character is docked.',
    without:
      'this character’s current ship will be shown as an ordinary asset at the station it is docked at, alongside any other ships parked there.',
  },
  {
    scope: 'esi-structures.read_character.v1',
    name: 'Mercenary dens',
    why: 'Tracks the Mercenary Dens this character has deployed — each den’s development and anarchy levels, running state, and reinforcement timer.',
    without: 'this character’s mercenary dens and their status will not be tracked.',
  },
  {
    scope: 'esi-fittings.read_fittings.v1',
    name: 'Saved fittings',
    why: 'Lists the ship fittings this character has saved in the game, so they can be browsed and opened in the fitting viewer. Read-only — fittings are never created, edited or deleted in game.',
    without: 'this character’s saved fittings will not be listed.',
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
