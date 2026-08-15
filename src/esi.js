export const userAgent = 'philihp@gmail.com edencom-link discord:philihp'

const ESI_BASE = 'https://esi.evetech.net/latest'

// Every failing ESI response throws this rather than a bare Error, so callers
// can branch on the status and body instead of regexing a message. The message
// is byte-for-byte what the plain Error carried before, since it's what lands in
// heartbeat.error and the logs.
export class EsiError extends Error {
  constructor(label, status, statusText, body, errorLimit = {}) {
    super(`${label}: ${status} ${statusText} body=${body}`)
    this.name = 'EsiError'
    this.status = status
    this.body = body
    // ESI's error budget, as reported on the failing response itself: how many
    // errors are left in the current window and how many seconds until it
    // resets. Carried on the error so a caller issuing many requests can stand
    // down *before* CCP starts answering 420 (see shouldStandDown in
    // src/jobs/structureResolution.js). Null when the response omitted them.
    this.errorLimitRemain = errorLimit.remain ?? null
    this.errorLimitReset = errorLimit.reset ?? null
  }
}

// The error budget headers, as numbers. Absent or unparseable reads as null —
// "unknown", never "zero", so a missing header can't look like an exhausted
// budget and stop a job that was fine.
const errorLimitOf = (response) => {
  const num = (name) => {
    const value = Number(response.headers.get(name))
    return Number.isFinite(value) ? value : null
  }
  return { remain: num('x-esi-error-limit-remain'), reset: num('x-esi-error-limit-reset') }
}

const esiError = async (response, path, label) => {
  const text = await response.text().catch(() => '')
  return new EsiError(label ?? path, response.status, response.statusText, text.slice(0, 500), errorLimitOf(response))
}

// A 403 that means "this character isn't allowed to ask", not "something broke".
// The corp endpoints require an in-game role (director, accountant, station
// manager…) *on top of* the OAuth scope, and CCP answers a role-less character
// with 403 and a body naming the missing role. That is a permission fact about
// the pilot, not a failure of the extract — see forEachCorporation in
// src/jobs/lib.js, which turns it into a recorded no-op.
//
// Deliberately matched on the body rather than on the bare status: a 403 also
// covers an expired or revoked token, which *is* a failure and must keep
// surfacing as one.
export const isRoleDenial = (e) =>
  e instanceof EsiError && e.status === 403 && /role|not in (the |that )?corporation/i.test(e.body ?? '')

const esiFetch = async (path, { access_token, params = {}, method = 'GET', body, label } = {}) => {
  const search = new URLSearchParams({ ...(access_token ? { token: access_token } : {}), ...params })
  const headers = { 'User-Agent': userAgent }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers['Cache-Control'] = 'no-cache'
  }
  const response = await fetch(`${ESI_BASE}${path}?${search}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    throw await esiError(response, path, label)
  }
  return response
}

const esiJson = async (path, opts) => (await esiFetch(path, opts)).json()

const esiPaged = async (path, opts) => {
  const response = await esiFetch(path, opts)
  return [await response.json(), response.headers.get('x-pages')]
}

// Conditional GET for the single-request snapshot endpoints (orders, wallet
// transactions, industry jobs): send the caller's stored ETag as If-None-Match
// and return { status, json, etag }. On 304 (Not Modified) ESI sends no body, so
// json is null and the caller skips re-processing an unchanged snapshot; the
// ETag is echoed on both 200 and 304 so the caller can refresh what it stored.
// One ETag covers the whole response here — safe only because these endpoints
// return the entire collection in a single, un-paginated request.
const esiConditionalJson = async (path, { access_token, params = {}, ifNoneMatch, label } = {}) => {
  const search = new URLSearchParams({ ...(access_token ? { token: access_token } : {}), ...params })
  const headers = { 'User-Agent': userAgent }
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch
  const response = await fetch(`${ESI_BASE}${path}?${search}`, { method: 'GET', headers })
  const etag = response.headers.get('etag')
  if (response.status === 304) return { status: 304, json: null, etag }
  if (!response.ok) {
    throw await esiError(response, path, label)
  }
  return { status: 200, json: await response.json(), etag }
}

// GET for endpoints where some ids are legitimately unreadable rather than
// broken: returns { status, json } and hands back json: null for the statuses
// the caller tolerates instead of throwing. Contract items are the case this
// exists for — a contract we can see in the list can still 403 (we're not a
// party to it any more) or 404 (deleted/expired past ESI's retention), and
// neither is a run-failing error.
const esiJsonTolerant = async (path, { access_token, params = {}, tolerate = [], label } = {}) => {
  const search = new URLSearchParams({ ...(access_token ? { token: access_token } : {}), ...params })
  const response = await fetch(`${ESI_BASE}${path}?${search}`, {
    method: 'GET',
    headers: { 'User-Agent': userAgent },
  })
  if (tolerate.includes(response.status)) return { status: response.status, json: null }
  if (!response.ok) {
    throw await esiError(response, path, label)
  }
  return { status: response.status, json: await response.json() }
}

// The newer, kebab-case ESI endpoints (Equinox onward — e.g. mercenary dens)
// don't live under the legacy `/latest` base. They're the "compatibility date"
// API: the same host with no version segment, gated by an `X-Compatibility-Date`
// header that pins the response shape, and authenticated with a Bearer token
// rather than the legacy `?token=` query param. Pin a fixed date so the schema
// we decode against never shifts under us; bump it deliberately when adopting a
// newer field. See https://developers.eveonline.com/docs/services/esi/.
const ESI_BASE_COMPAT = 'https://esi.evetech.net'
const ESI_COMPATIBILITY_DATE = '2026-07-12'

const esiCompatJson = async (path, { access_token, params = {}, label } = {}) => {
  const qs = new URLSearchParams(params).toString()
  const headers = {
    'User-Agent': userAgent,
    'X-Compatibility-Date': ESI_COMPATIBILITY_DATE,
    Accept: 'application/json',
  }
  if (access_token) headers.Authorization = `Bearer ${access_token}`
  const response = await fetch(`${ESI_BASE_COMPAT}${path}${qs ? `?${qs}` : ''}`, { headers })
  if (!response.ok) {
    throw await esiError(response, path, label)
  }
  return response.json()
}

export const assets = (access_token, characterID, page = 1) =>
  esiPaged(`/characters/${characterID}/assets/`, {
    access_token,
    params: { page },
    label: `assets ${characterID} page=${page}`,
  })

export const blueprints = (access_token, characterID, page = 1) =>
  esiPaged(`/characters/${characterID}/blueprints/`, {
    access_token,
    params: { page },
    label: `blueprints ${characterID} page=${page}`,
  })

// Conditional (ETag-aware); returns { status, json, etag }. See esiConditionalJson.
export const transactions = (access_token, characterID, ifNoneMatch) =>
  esiConditionalJson(`/characters/${characterID}/wallet/transactions/`, {
    access_token,
    ifNoneMatch,
    label: `transactions ${characterID}`,
  })

// Conditional (ETag-aware); returns { status, json, etag }. See esiConditionalJson.
export const industryJobs = (access_token, characterID, ifNoneMatch) =>
  esiConditionalJson(`/characters/${characterID}/industry/jobs/`, {
    access_token,
    params: { include_completed: 'true' },
    ifNoneMatch,
    label: `industry jobs ${characterID}`,
  })

export const wallet = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/wallet/`, {
    access_token,
    label: `wallet ${characterID}`,
  })

// A character's open market orders (buy and sell). Not paginated — ESI returns
// every open order in one response. Conditional (ETag-aware); returns
// { status, json, etag }. See esiConditionalJson.
export const orders = (access_token, characterID, ifNoneMatch) =>
  esiConditionalJson(`/characters/${characterID}/orders/`, {
    access_token,
    ifNoneMatch,
    label: `orders ${characterID}`,
  })

// A character's saved ship fittings. Not paginated — ESI returns the whole
// library in one response — so it qualifies for a conditional GET; returns
// { status, json, etag }. See esiConditionalJson.
//
// ESI exposes only *personal* fittings: there is no corporation or alliance
// fittings endpoint, and the response carries no folder discriminator, so a
// doctrine fit copied to personal is indistinguishable from any other. See
// docs/fittings.md.
export const fittings = (access_token, characterID, ifNoneMatch) =>
  esiConditionalJson(`/characters/${characterID}/fittings/`, {
    access_token,
    ifNoneMatch,
    label: `fittings ${characterID}`,
  })

// A character's contracts — every contract they issued or were assigned,
// covering the last 30 days plus anything still outstanding or in progress.
// Page-numbered (x-pages), so it is deliberately NOT a conditional request: an
// ETag would only ever cover one page, and a 304 on page 1 says nothing about
// the rest.
export const contracts = (access_token, characterID, page = 1) =>
  esiPaged(`/characters/${characterID}/contracts/`, {
    access_token,
    params: { page },
    label: `contracts ${characterID} page=${page}`,
  })

// The item list of one contract. Immutable once the contract exists, so it is
// fetched once per contract and never re-polled. Tolerates 403 (no longer a
// party to it) and 404 (gone from ESI's retention window) as "no items we can
// ever read", which the caller records so the contract isn't retried forever.
export const contractItems = (access_token, characterID, contractID) =>
  esiJsonTolerant(`/characters/${characterID}/contracts/${contractID}/items/`, {
    access_token,
    tolerate: [403, 404],
    label: `contractItems ${characterID}/${contractID}`,
  })

// A corporation's contracts. Requires no in-game role beyond membership for
// corp-issued contracts. Page-numbered, same as the character endpoint.
export const corpContracts = (access_token, corporationID, page = 1) =>
  esiPaged(`/corporations/${corporationID}/contracts/`, {
    access_token,
    params: { page },
    label: `corpContracts ${corporationID} page=${page}`,
  })

// The item list of one corporation contract. Same once-only, tolerant contract
// as its per-character twin above.
export const corpContractItems = (access_token, corporationID, contractID) =>
  esiJsonTolerant(`/corporations/${corporationID}/contracts/${contractID}/items/`, {
    access_token,
    tolerate: [403, 404],
    label: `corpContractItems ${corporationID}/${contractID}`,
  })

export const character = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/`, {
    access_token,
    label: `character ${characterID}`,
  })

export const corpStructures = (access_token, corporationID, page = 1) =>
  esiPaged(`/corporations/${corporationID}/structures/`, {
    access_token,
    params: { page },
    label: `corpStructures ${corporationID} page=${page}`,
  })

export const corpAssets = (access_token, corporationID, page = 1) =>
  esiPaged(`/corporations/${corporationID}/assets/`, {
    access_token,
    params: { page },
    label: `corpAssets ${corporationID} page=${page}`,
  })

export const corpBlueprints = (access_token, corporationID, page = 1) =>
  esiPaged(`/corporations/${corporationID}/blueprints/`, {
    access_token,
    params: { page },
    label: `corpBlueprints ${corporationID} page=${page}`,
  })

export const corpIndustryJobs = (access_token, corporationID, page = 1) =>
  esiPaged(`/corporations/${corporationID}/industry/jobs/`, {
    access_token,
    params: { page, include_completed: 'true' },
    label: `corpIndustryJobs ${corporationID} page=${page}`,
  })

export const corpWalletJournal = (access_token, corporationID, division, page = 1) =>
  esiPaged(`/corporations/${corporationID}/wallets/${division}/journal/`, {
    access_token,
    params: { page },
    label: `corpWalletJournal ${corporationID} div=${division} page=${page}`,
  })

// A corp wallet division's market transactions (buys and sells). Like the
// character endpoint it is not page-numbered — ESI returns the most recent batch
// in one response (older history is reachable via from_id, which we don't need
// for an hourly sync). Requires the Accountant or Junior Accountant role in game.
export const corpTransactions = (access_token, corporationID, division) =>
  esiJson(`/corporations/${corporationID}/wallets/${division}/transactions/`, {
    access_token,
    label: `corpTransactions ${corporationID} div=${division}`,
  })

export const assetNames = (access_token, characterID, ids) =>
  esiJson(`/characters/${characterID}/assets/names/`, {
    access_token,
    method: 'POST',
    body: ids,
    label: `assetNames ${characterID}`,
  })

// Public (no token): per-solar-system industry cost indices for every system
// with activity in it. Each entry is { solar_system_id, cost_indices: [{ activity, cost_index }] }.
export const industrySystems = () =>
  esiJson(`/industry/systems/`, {
    label: `industrySystems`,
  })

export const universeNames = (ids) =>
  esiJson(`/universe/names/`, {
    method: 'POST',
    body: ids,
    label: `universeNames(${ids.length})`,
  })

// Resolve a single player Upwell structure. Requires esi-universe.read_structures.v1
// and docking access for the token's character, else ESI returns 403.
export const universeStructure = (access_token, structureID) =>
  esiJson(`/universe/structures/${structureID}/`, {
    access_token,
    label: `universeStructure ${structureID}`,
  })

// Public (no token): every *fully public* player structure id — CCP's wording
// for a completely open access control list, which is why this is a small
// fraction of what's anchored in New Eden (886 ids as of 2026-08-12). Ids only;
// naming them still needs a token with access, or EVE Ref. Feeds the
// structure-directory job.
export const universeStructures = () =>
  esiJson(`/universe/structures/`, {
    label: 'universeStructures',
  })

// Public (no token): resolve a single NPC station. Returns { system_id, name,
// type_id, ... }; used to place clones parked in NPC stations in a solar system.
export const universeStation = (stationID) =>
  esiJson(`/universe/stations/${stationID}/`, {
    label: `universeStation ${stationID}`,
  })

// A character's current solar system (and station/structure, if docked).
export const characterLocation = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/location/`, {
    access_token,
    label: `location ${characterID}`,
  })

// A character's home clone plus every jump clone, each with its location and
// (for jump clones) the implants installed in it.
export const characterClones = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/clones/`, {
    access_token,
    label: `clones ${characterID}`,
  })

// The implants currently plugged into whichever clone body the character
// presently occupies.
export const characterImplants = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/implants/`, {
    access_token,
    label: `implants ${characterID}`,
  })

// The character's trained skills — { skills: [{ skill_id, active_skill_level,
// trained_skill_level, skillpoints_in_skill }], total_sp, unallocated_sp }.
// active_skill_level is the level currently in effect (what an omega/alpha clone
// can actually use); trained_skill_level is what's been trained regardless.
export const characterSkills = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/skills/`, {
    access_token,
    label: `skills ${characterID}`,
  })

// The ship the character is currently in — { ship_item_id, ship_name,
// ship_type_id }. This is the item_id of whichever ship the character is
// presently sitting in, docked or not, distinguishing it from any other ship
// the character owns that happens to be parked at the same location.
export const characterShip = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/ship/`, {
    access_token,
    label: `ship ${characterID}`,
  })

export const characterAffiliations = (ids) =>
  esiJson(`/characters/affiliation/`, {
    method: 'POST',
    body: ids,
    label: `characterAffiliations(${ids.length})`,
  })

// The character's deployed Mercenary Dens — a full snapshot list of
// { id, planet_id }. Compatibility-date endpoint (see esiCompatJson).
export const characterMercenaryDens = (access_token, characterID) =>
  esiCompatJson(`/characters/${characterID}/structures/mercenary-dens`, {
    access_token,
    label: `mercenary-dens ${characterID}`,
  })

// One den's live status by id: state (Running/Paused/Disabled), development &
// anarchy evolution (each { amount, level }), infomorphs, reinforcement_timer
// ({ end }), and the skyhook it draws from. Compatibility-date endpoint.
export const characterMercenaryDen = (access_token, characterID, denID) =>
  esiCompatJson(`/characters/${characterID}/structures/mercenary-dens/${denID}`, {
    access_token,
    label: `mercenary-den ${characterID}/${denID}`,
  })
