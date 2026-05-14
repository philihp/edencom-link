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
