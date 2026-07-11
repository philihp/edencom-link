import { SCOPE as CLONES_SCOPE, makeSystemResolver, syncCharacterClones } from './characterClones.js'
import { SCOPE as IMPLANTS_SCOPE, syncCharacterImplants } from './characterImplants.js'
import { SCOPE as LOCATION_SCOPE, syncCharacterLocation } from './characterLocation.js'
import { SCOPE as WALLET_SCOPE, syncCharacterWallet } from './characterWallet.js'
import { cli, forEachCharacterAnyScope, forEachSequential } from './lib.js'

const TAG = 'character-status'

// The four live-state per-character ESI pulls — wallet balance, current
// location, active-clone implants, and clones — folded into a single extract
// job. Each is a cheap, single-call endpoint that used to run as its own job
// (and its own Vercel function invocation) on its own schedule; combining them
// means one queue message / one function invocation per character covers all
// four, sharing the token refresh and cutting per-invocation overhead.
//
// They keep their separate ESI scopes and separate destination tables, so a
// character only carrying some of the scopes runs only those endpoints, and
// each endpoint is fault-isolated: one failing (e.g. a clones 403 when the
// token lacks docking access) never aborts the others. The individual
// character-wallet / character-location / character-implants / character-clones
// job modules remain runnable on their own (CLI + queue) for manual use; only
// their scheduling and the /character/refresh UI merge into this job.
export const SCOPES = [WALLET_SCOPE, LOCATION_SCOPE, IMPLANTS_SCOPE, CLONES_SCOPE]

export const runCharacterStatus = ({ characterIds } = {}) => {
  // One resolver memo for the whole run: clones across characters cluster in the
  // same few stations/structures, so each location resolves at most once.
  const resolveSystem = makeSystemResolver()

  const parts = [
    { scope: WALLET_SCOPE, label: 'wallet', run: syncCharacterWallet },
    { scope: LOCATION_SCOPE, label: 'location', run: syncCharacterLocation },
    { scope: IMPLANTS_SCOPE, label: 'implants', run: syncCharacterImplants },
    { scope: CLONES_SCOPE, label: 'clones', run: (handlerCtx) => syncCharacterClones(handlerCtx, resolveSystem) },
  ]

  return forEachCharacterAnyScope(TAG, { scopes: SCOPES, characterIds }, async (handlerCtx) => {
    const { scopes, ctx } = handlerCtx
    // Run each endpoint the token is authorized for, isolating failures so a
    // partial outage still records the parts that succeeded. The character's
    // single character-status heartbeat is recorded by forEachCharacterAnyScope
    // regardless, so the /character/refresh cell reflects that the pull ran.
    await forEachSequential(parts, async (part) => {
      if (!scopes.includes(part.scope)) return
      try {
        await part.run(handlerCtx)
      } catch (e) {
        console.error(`[${TAG}] ${ctx}: ${part.label} failed: name=${e?.name} message=${e?.message}`)
      }
    })
  })
}

cli(import.meta.url, TAG, runCharacterStatus)
