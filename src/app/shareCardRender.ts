import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// What the link-preview card routes (ship/[itemId]/card, asset/[locationId]/
// card) share around next/og: the fonts, the pictures fetched ahead of
// Satori, and how long a CDN may keep a card.

// Chat clients keep their own copy of an embed, so this only bounds how long
// our CDN keeps serving a card after the share is revoked or the item changes.
export const CARD_CACHE_CONTROL = 'public, max-age=600, s-maxage=600'

// Read once per process. The fonts are traced into each card's function
// bundle by outputFileTracingIncludes in next.config.mjs.
const font = (file: string) => readFile(join(process.cwd(), 'public/fonts', file))
let fonts: Promise<Buffer[]> | null = null

// The fonts as ImageResponse takes them: the brand sans in two weights, and
// the expanded face the titles use.
export const cardFonts = async () => {
  const [regular, bold, expandedBold] = await (fonts ??= Promise.all([
    font('evesansneue-regular.otf'),
    font('evesansneue-bold.otf'),
    font('evesansneue-expandedbold.otf'),
  ]))
  return [
    { name: 'Eve Sans Neue', data: regular, weight: 400 as const, style: 'normal' as const },
    { name: 'Eve Sans Neue', data: bold, weight: 700 as const, style: 'normal' as const },
    { name: 'Eve Sans Neue Expanded', data: expandedBold, weight: 700 as const, style: 'normal' as const },
  ]
}

// Satori would fetch each <img> itself and fail the whole card on one bad
// answer. So the routes fetch them first, with a time limit, and a picture
// that does not arrive leaves an empty frame rather than no card.
export const dataUri = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) return null
    const type = response.headers.get('content-type') ?? 'image/png'
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
  } catch {
    return null
  }
}
