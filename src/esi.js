export const userAgent = 'philihp@gmail.com eve-hangar discord:philihp'

const ESI_BASE = 'https://esi.evetech.net/latest'

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
    const text = await response.text().catch(() => '')
    throw new Error(`${label ?? path}: ${response.status} ${response.statusText} body=${text.slice(0, 500)}`)
  }
  return response
}

const esiJson = async (path, opts) => (await esiFetch(path, opts)).json()

const esiPaged = async (path, opts) => {
  const response = await esiFetch(path, opts)
  return [await response.json(), response.headers.get('x-pages')]
}

export const assets = (access_token, characterID, page = 1) =>
  esiPaged(`/characters/${characterID}/assets/`, {
    access_token,
    params: { page },
    label: `assets ${characterID} page=${page}`,
  })

export const transactions = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/wallet/transactions/`, {
    access_token,
    label: `transactions ${characterID}`,
  })

export const industryJobs = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/industry/jobs/`, {
    access_token,
    params: { include_completed: 'true' },
    label: `industry jobs ${characterID}`,
  })

export const wallet = (access_token, characterID) =>
  esiJson(`/characters/${characterID}/wallet/`, {
    access_token,
    label: `wallet ${characterID}`,
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

export const corpWalletJournal = (access_token, corporationID, division, page = 1) =>
  esiPaged(`/corporations/${corporationID}/wallets/${division}/journal/`, {
    access_token,
    params: { page },
    label: `corpWalletJournal ${corporationID} div=${division} page=${page}`,
  })

export const assetNames = (access_token, characterID, ids) =>
  esiJson(`/characters/${characterID}/assets/names/`, {
    access_token,
    method: 'POST',
    body: ids,
    label: `assetNames ${characterID}`,
  })

export const universeNames = (ids) =>
  esiJson(`/universe/names/`, {
    method: 'POST',
    body: ids,
    label: `universeNames(${ids.length})`,
  })

export const characterAffiliations = (ids) =>
  esiJson(`/characters/affiliation/`, {
    method: 'POST',
    body: ids,
    label: `characterAffiliations(${ids.length})`,
  })
