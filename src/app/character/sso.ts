import SingleSignOn from '@philihp/eve-sso'

import { defaultScopes } from './scopes'

const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID
const EVE_SECRET_KEY = process.env.EVE_SECRET_KEY
const EVE_CALLBACK_URL = process.env.EVE_CALLBACK_URL

// Every scope we may request. The set actually requested for a given player is
// narrowed to their saved preferences in the register flow; see scopes.ts.
export const scopes = defaultScopes

export const userAgent = 'philihp@gmail.com edencom-link discord:philihp'
export const sso = new SingleSignOn(EVE_CLIENT_ID!, EVE_SECRET_KEY!, EVE_CALLBACK_URL!, userAgent)
