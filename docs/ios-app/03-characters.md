# Phase 3 — Characters: who, where, in what, how fresh

## Goal

The first real screen, and the one the app is for. One card per linked
character: portrait, name, corporation and alliance, ISK, current place, the
ship they are in, their clone state, and how fresh each of those is. It is the
character half of `/account/registrations`, on a phone.

## Parity inventory

Taken from `src/app/character/characterData.ts` (the shared seam the web page
renders from — read it before starting). Tick every line:

- [ ] Portrait (`images.evetech.net/characters/<id>/portrait?size=128`), name,
      corporation name, alliance name (null-safe).
- [ ] Wallet balance, formatted as the web does (`Isk`), with its freshness.
- [ ] Location: system name and security, station or structure name when
      docked; "In space" otherwise; freshness.
- [ ] Current ship: type name and the ship's own name, type icon.
- [ ] Clone: home station, jump-clone count, implant count; next clone jump
      availability.
- [ ] Job slots in use / max for manufacturing, research and reactions
      (`src/app/industry/jobSlots.ts` gives the ceilings; the counts come from
      industry jobs).
- [ ] Data freshness per extract job, as the web's `Freshness` dots.
- [ ] Which character is the account's main (`registration.is_main`).

Out of scope here, deliberately: adding a character (EVE SSO, on the website),
grants, and the extract-job matrix. The account tab links to the website for
them.

## GraphQL additions (server side, this phase's first PR)

`Character` today carries identity only (`id`, `name`, `characterId`,
corporation and alliance). Add one nested type so the app, Links and MCP
`run_query` all gain it:

```graphql
type CharacterStatus {
  isMain: Boolean!
  wallet: WalletSnapshot          # balance, observedAt
  location: LocationSnapshot      # systemId, systemName, security, placeName, docked, observedAt
  ship: ShipSnapshot              # typeId, typeName, name, observedAt
  clone: CloneSnapshot            # homeStationName, jumpClones, implants, nextJumpAt, observedAt
  jobSlots: [JobSlotFamily!]!     # family, used, max
  refreshed: [JobFreshness!]!     # job, endedAt, ok
}
extend type Character { status: CharacterStatus! }
```

Resolve `status` lazily (only when selected), reading the same tables
`characterData.ts` reads: `character_wallet`, `character_location`,
`character_ship`, `character_clone`/`character_clone_state`/`character_implant`,
`character_skill` for the slot ceilings, and `latest_heartbeats()` for
freshness. Session mode gives RLS; token mode must filter
`.in('registration_id', ctx.registrationIds)` like every other resolver (the
leak guard in `context.ts`). Put the pure shaping (slot counts from jobs,
freshness band) in `src/app/api/graphql/characterStatus.ts`, tested in
`test/graphqlCharacterStatus.test.ts`.

Where `characterData.ts` already has a pure function for a value, call it; do
not restate the rule.

## Files (app side)

- `mobile/app/(tabs)/characters.tsx` — the list; pull to refresh.
- `mobile/app/character/[id].tsx` — one character, the full card plus the
  freshness table.
- `mobile/src/screens/characters/` — row and card components, the query
  document, a pure `sortCharacters` (main first, then by name) with a test.
- `mobile/src/ui/TypeIcon.tsx` — see phase 4; this phase only needs the ship
  icon, so phase 4's `TypeIcon` may land here first if 4 has not started.

## Steps

1. Server PR: the `status` field, resolvers, tests, and `link_schema` output
   checked (the MCP tool reads the schema text, so it updates itself).
2. App: the list with identity and ISK only; ship it to the simulator.
3. Add location, ship, clone, slots, freshness.
4. The detail screen.

## Done when

- Every line of the parity inventory is ticked, with a screenshot per line
  pasted in the PR.
- The `characters` query the app sends validates against the schema in the
  phase-2 documents test.
- The web page `/account/registrations` is unchanged (it does not use the new
  field; parity is checked by eye against it).

## Risks and notes

- **Freshness needs the clock.** `observedAt` is UTC; the band is computed on
  the phone from `Date.now()`. Reuse the band thresholds from
  `src/app/freshness.ts` through the phase-0 sharing decision.
- **Many characters.** An account can hold dozens. The list is a `FlatList`,
  and the `status` field is requested only for visible rows if the first
  measurement shows the full query over 500 ms.
