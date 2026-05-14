import { pipe, reduce, pluck, range, splitEvery } from 'ramda'
import { userAgent, assets, assetNames } from './esi.js'
import SingleSignOn from './sso.js'
import { authenticate, selectCharacters, selectToken, upsertToken, upsertAssets } from './supabase.js'

const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID
const EVE_SECRET_KEY = process.env.EVE_SECRET_KEY
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL

const sso = new SingleSignOn(EVE_CLIENT_ID, EVE_SECRET_KEY, EVE_CALLBACK_URL, { userAgent })

const scopes = [
  'publicData',
  'esi-wallet.read_character_wallet.v1',
  'esi-assets.read_assets.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-markets.read_character_orders.v1',
]

const accessToken = async (character_id) => {
  // get the oldest refresh token that has all of the scopes we need, refresh that so we get a new unexpired
  // access_token (it's probably expired, but even if it isn't, shouldn't hurt to do it anyway
  const token = await selectToken(character_id, scopes)
  const old_token = token?.data[0]?.refresh_token
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
    scope: [scp].flat(), // if there is just one element in the returned `scp`, then it isn't in an array
  })
  return [access_token, characterID]
}

const execute = async () => {
  await authenticate()
  const characters = await selectCharacters(
    'id',
    'KA1oPnkU/qG1zsV6BfY8CbDqEKc=' // William Ralston
    // 'wWlgxxUMwTlfDdzpzUw3io3zxbY=' // sir cuddles
    //'fTWbcvorPidXBXybfbo/JpND0Qc=' // international blue
  )

  const character_id = characters[0]
  const [refresh_token, characterID] = await accessToken(character_id)

  console.time(`all asst chunk`)

  const assetList = []
  console.time(`asst chunk 1`)
  const [firstAssetPage, maxPages] = await assets(refresh_token, characterID, 1)
  console.timeEnd(`asst chunk 1`)
  const firstAssets = firstAssetPage.map((a) => ({ ...a, character_id, is_blueprint_copy: !!a.is_blueprint_copy }))
  assetList.push(...firstAssets)

  await range(2, Number.parseInt(maxPages, 10) + 1).reduce(async (accum, page) => {
    console.time(`asst chunk ${page}`)
    const [assetPage] = await assets(refresh_token, characterID, page)
    const newAssets = assetPage.map((a) => ({ ...a, character_id, is_blueprint_copy: !!a.is_blueprint_copy }))
    console.timeEnd(`asst chunk ${page}`)
    assetList.push(...newAssets)
    return accum
  }, assetList)

  console.timeEnd(`all asst chunk`)

  await upsertAssets(assetList)

  console.time('all name chunks')

  const item_names = await pipe(
    pluck('item_id'),
    splitEvery(1000),
    reduce(async (accum, ids) => {
      // start the API call
      const names = await assetNames(refresh_token, characterID, ids)
      // wait for previous threads to finish
      const awaitAccum = await accum
      // merge the two lists
      awaitAccum.push(...names)
      return awaitAccum
    }, [])
  )(assetList)
  console.log(item_names)

  console.timeEnd('all name chunks')
}

execute()
