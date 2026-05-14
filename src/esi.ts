export const userAgent = 'Sir Cuddles <philihp@gmail.com> eve-hangar'

export type EsiAsset = {
  item_id: number
  type_id: number
  location_id: number
  location_type: string
  location_flag: string
  quantity: number
  is_singleton: boolean
  is_blueprint_copy?: boolean
}

export type EsiAssetName = {
  item_id: number
  name: string
}

export const assets = async (
  access_token: string,
  characterID: string,
  page = 1
): Promise<[EsiAsset[], string | null]> => {
  const response = await fetch(
    `https://esi.evetech.net/latest/characters/${characterID}/assets/?` +
      new URLSearchParams({
        token: access_token,
        page: `${page}`,
      }),
    {
      method: 'GET',
      headers: { 'User-Agent': userAgent },
    }
  )
  const pages = response.headers.get('x-pages')
  const data = (await response.json()) as EsiAsset[]
  return [data, pages]
}

export const assetNames = async (
  access_token: string,
  characterID: string,
  ids: number[]
): Promise<EsiAssetName[]> => {
  const params = new URLSearchParams({ token: access_token })
  const response = await fetch(
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
  return (await response.json()) as EsiAssetName[]
}
