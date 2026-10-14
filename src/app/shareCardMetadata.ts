import type { Metadata } from 'next'
import { headers } from 'next/headers'

// The link preview a share link unfurls into in Discord, Slack or X: a title,
// a line about the item, and a card image. Shared by the ship page and the
// asset page, whose cards differ but whose tags must not.

// The origin a chat client reached the page on, so the preview image is an
// absolute URL on the same host (production or a preview deployment).
export const requestOrigin = async (): Promise<string> => {
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host')
  const proto = headerList.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https')
  return host ? `${proto}://${host}` : ''
}

// The card image takes the same share parameter as the page, so it opens
// exactly what the link opens.
export const shareQuery = ({ share, token }: { share?: string; token?: string }): string =>
  new URLSearchParams(share ? { share } : { token: token ?? '' }).toString()

export const shareCardMetadata = async (card: {
  // The item's own name where it has one, else its type's.
  title: string
  typeName: string
  description: string
  // The card route, absolute from the site root, query included.
  imagePath: string
  width: number
  height: number
}): Promise<Metadata> => {
  // An unnamed item's title is its type name, which needs saying only once.
  const named = card.title !== card.typeName
  const image = {
    url: `${await requestOrigin()}${card.imagePath}`,
    width: card.width,
    height: card.height,
    alt: named ? `${card.title}, ${card.typeName}` : card.title,
  }
  const title = named ? `${card.title} (${card.typeName})` : card.title
  return {
    title: `${title} · Edencom Link`,
    description: card.description,
    openGraph: { type: 'website', siteName: 'Edencom Link', title, description: card.description, images: [image] },
    // Discord and X draw the image full width only for a large-image card.
    twitter: { card: 'summary_large_image', title, description: card.description, images: [image] },
  }
}
