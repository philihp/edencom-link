export const userAgent = 'Sir Cuddles <philihp@gmail.com> eve-hangar'

export const assets = async (access_token, characterID, page = 1) => {
  const assetResponse = await fetch(
    `https://esi.evetech.net/latest/characters/${characterID}/assets/?` +
      new URLSearchParams({
        token: access_token,
        page,
      }),
    {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
    }
  )
  const pages = assetResponse.headers.get('x-pages')
  const data = await assetResponse.json()
  return [data, pages]
}

export const transactions = async (access_token, characterID) => {
  const response = await fetch(
    `https://esi.evetech.net/latest/characters/${characterID}/wallet/transactions/?` +
      new URLSearchParams({
        token: access_token,
      }),
    {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
    }
  )
  if (!response.ok) {
    throw new Error(`transactions ${characterID}: ${response.status} ${response.statusText}`)
  }
  return await response.json()
}

export const industryJobs = async (access_token, characterID) => {
  const response = await fetch(
    `https://esi.evetech.net/latest/characters/${characterID}/industry/jobs/?` +
      new URLSearchParams({
        token: access_token,
        include_completed: 'true',
      }),
    {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
    }
  )
  if (!response.ok) {
    throw new Error(`industry jobs ${characterID}: ${response.status} ${response.statusText}`)
  }
  return await response.json()
}

export const wallet = async (access_token, characterID) => {
  const response = await fetch(
    `https://esi.evetech.net/latest/characters/${characterID}/wallet/?` +
      new URLSearchParams({
        token: access_token,
      }),
    {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
    }
  )
  if (!response.ok) {
    throw new Error(`wallet ${characterID}: ${response.status} ${response.statusText}`)
  }
  return await response.json()
}

export const character = async (access_token, characterID) => {
  const response = await fetch(
    `https://esi.evetech.net/latest/characters/${characterID}/?` +
      new URLSearchParams({
        token: access_token,
      }),
    {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
    }
  )
  if (!response.ok) {
    throw new Error(`character ${characterID}: ${response.status} ${response.statusText}`)
  }
  return await response.json()
}

export const corpStructures = async (access_token, corporationID, page = 1) => {
  const response = await fetch(
    `https://esi.evetech.net/latest/corporations/${corporationID}/structures/?` +
      new URLSearchParams({
        token: access_token,
        page,
      }),
    {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
    }
  )
  if (!response.ok) {
    throw new Error(`corpStructures ${corporationID}: ${response.status} ${response.statusText}`)
  }
  const pages = response.headers.get('x-pages')
  const data = await response.json()
  return [data, pages]
}

export const assetNames = async (access_token, characterID, ids) => {
  const params = new URLSearchParams({
    token: access_token,
  })
  const assetResponse = await fetch(
    `https://esi.evetech.net/latest/characters/${characterID}/assets/names/?` + params,
    {
      method: 'POST',
      headers: {
        'User-Agent': userAgent,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(ids),
    }
  )
  // const data = await assetResponse.json()
  return await assetResponse.json()
}
