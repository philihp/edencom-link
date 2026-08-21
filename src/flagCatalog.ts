// The dark-launch flag vocabulary, with no dependencies of its own.
//
// Split out of src/flags.ts so the Chancellor's checkbox form — a client
// component — can name the flags without dragging that module's service-role
// Supabase client into the browser bundle. That was always the wrong shape;
// it became a hard build error once the client factories started importing
// the Server-Timing collector, which needs node:async_hooks (a Node built-in
// with no browser counterpart). Server code keeps importing everything from
// '@/flags', which re-exports these.

// Flag names live here so callers can't typo them apart.
export const GRAPHQL_FLAG = 'graphql'
export const LINK_FLAG = 'link'
export const FIT_UI_FLAG = 'fit-ui'

// Every flag the Chancellor tools offer as a checkbox, with the copy shown
// beside it. A flag an account already carries that isn't listed here still
// renders (as an unlabelled checkbox), so a hand-set flag is never silently
// dropped when a Chancellor saves.
export const KNOWN_FLAGS: { flag: string; label: string }[] = [
  { flag: GRAPHQL_FLAG, label: 'GraphQL API and its playground (/graphql)' },
  { flag: LINK_FLAG, label: 'Links — Data Links, saved queries issued to others (/link)' },
  { flag: FIT_UI_FLAG, label: 'Our own ship-fitting stack, in progress (/item/[itemId])' },
]
