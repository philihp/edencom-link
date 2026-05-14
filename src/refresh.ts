import { pluck, range, splitEvery } from 'ramda'
import { userAgent, assets, assetNames, type EsiAssetName } from './esi'
import SingleSignOn from './sso'
import { authenticate, selectCharacters, selectToken, upsertToken, upsertAssets } from './supabase'

const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID!
const EVE_SECRET_KEY = process.env.EVE_SECRET_KEY!
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL!

const sso = new SingleSignOn(EVE_CLIENT_ID, EVE_SECRET_KEY, EVE_CALLBACK_URL, { userAgent })

const scopes = [
  'publicData',
  'esi-wallet.read_character_wallet.v1',
  'esi-assets.read_assets.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-markets.read_character_orders.v1',
]

const accessToken = async (character_id: string): Promise<[string, string]> => {
  // get the oldest refresh token that has all of the scopes we need, refresh that so we get a new unexpired
  // access_token (it's probably expired, but even if it isn't, shouldn't hurt to do it anyway)
  const token = await selectToken(character_id, scopes)
  const old_token = token?.data?.[0]?.refresh_token as string | undefined
  if (!old_token) throw new Error(`No refresh token for character ${character_id}`)
  const {
    access_token,
    refresh_token,
    decoded_access_token: { scp = [], iat, exp, sub },
  } = await sso.getAccessToken(old_token, true)
  const characterID = sub.split(':')[2]
  await upsertToken({
    character_id,
    access_token,
    refresh_token,
    issued_at: new Date(iat * 1000).toISOString(),
    expires_at: new Date(exp * 1000).toISOString(),
    scope: [scp].flat(),
  })
  return [access_token, characterID]
}

const execute = async () => {
  await authenticate()
  const characters = await selectCharacters(
    'id',
    'KA1oPnkU/qG1zsV6BfY8CbDqEKc=' // William Ralston
  )

  const character_id = characters[0]
  const [refresh_token, characterID] = await accessToken(character_id)

  console.time(`all asst chunk`)

  const assetList: Record<string, unknown>[] = []
  console.time(`asst chunk 1`)
  const [firstAssetPage, maxPages] = await assets(refresh_token, characterID, 1)
  console.timeEnd(`asst chunk 1`)
  const firstAssets = firstAssetPage.map((a) => ({
    ...a,
    character_id,
    is_blueprint_copy: !!a.is_blueprint_copy,
  }))
  assetList.push(...firstAssets)

  await range(2, Number.parseInt(maxPages ?? '1', 10) + 1).reduce<Promise<unknown[]>>(async (accum, page) => {
    console.time(`asst chunk ${page}`)
    const [assetPage] = await assets(refresh_token, characterID, page)
    const newAssets = assetPage.map((a) => ({
      ...a,
      character_id,
      is_blueprint_copy: !!a.is_blueprint_copy,
    }))
    console.timeEnd(`asst chunk ${page}`)
    assetList.push(...newAssets)
    return accum
  }, Promise.resolve(assetList))

  console.timeEnd(`all asst chunk`)

  await upsertAssets(assetList)

  console.time('all name chunks')

  const itemIdChunks = splitEvery(1000, pluck('item_id', assetList as { item_id: number }[]))
  const item_names = await itemIdChunks.reduce<Promise<EsiAssetName[]>>(async (accum, ids) => {
    const names = await assetNames(refresh_token, characterID, ids)
    const awaitAccum = await accum
    awaitAccum.push(...names)
    return awaitAccum
  }, Promise.resolve([]))
  console.log(item_names)

  console.timeEnd('all name chunks')
}

execute()
