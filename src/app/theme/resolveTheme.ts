import { headers } from 'next/headers'
import { isDaytime } from './sun'

export type Theme = 'light' | 'dark'

/**
 * Pick the theme from where the visitor is rather than from their device.
 *
 * Uses Vercel's edge geo headers to locate the request, works out whether the
 * sun is currently up there, and returns 'light' by day / 'dark' by night.
 * When the location is unknown (e.g. local dev, or no geo headers) it returns
 * undefined so the CSS can fall back to the device's prefers-color-scheme.
 */
export const resolveTheme = async (): Promise<Theme | undefined> => {
  const h = await headers()
  const lat = Number(h.get('x-vercel-ip-latitude'))
  const lng = Number(h.get('x-vercel-ip-longitude'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined
  return isDaytime(lat, lng) ? 'light' : 'dark'
}
