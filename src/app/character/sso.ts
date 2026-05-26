import SingleSignOn from '../../sso.js'

const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID
const EVE_SECRET_KEY = process.env.EVE_SECRET_KEY
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL

export const scopes = [
  'publicData',
  'esi-wallet.read_character_wallet.v1',
  'esi-assets.read_assets.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-markets.read_character_orders.v1',
  'esi-corporations.read_structures.v1',
  // 'esi-characters.read_blueprints.v1',
]

export const userAgent = 'Sir Cuddles <philihp@gmail.com> eve-hangar'
export const sso = new SingleSignOn(EVE_CLIENT_ID, EVE_SECRET_KEY, EVE_CALLBACK_URL, {
  userAgent,
})
