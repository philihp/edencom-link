import { ImageResponse } from 'next/og'

import type { StackIcon } from './asset/[locationId]/card/cardModel'
import { compactCount } from './asset/[locationId]/card/cardModel'
import { iconUrl } from './iconVariation'
import { CARD_CACHE_CONTROL, cardFonts, dataUri } from './shareCardRender'
import { CARD_HEIGHT, CARD_WIDTH } from './ship/[itemId]/card/cardModel'
import type { ShipOwner } from './ship/[itemId]/shipHeading'

// The link-preview card for everything a share link opens that is not a ship:
// a container, a place, a blueprint library, a corpse collection, a Link. The
// ship card (ship/[itemId]/card) shows a hull slot by slot; this one shows a
// picture and an owner on the left, a title in a tier colour and a grid of
// icons on the right, and a figure at the foot.
//
// Drawn with next/og (Satori), which draws only flexbox and a subset of CSS:
// every element with more than one child is display: flex, and every <img> is
// a data: URI fetched first (shareCardRender.ts).

export type SummaryCard = {
  title: string
  // The line under the title; empty for none.
  subtitle: string
  // The border and title colour.
  color: string
  // The picture on the left, or null for a text label in its place.
  picture: { url: string; round: boolean } | null
  pictureLabel: string
  owner: ShipOwner | null
  stacks: StackIcon[]
  // Shown in place of the icons when there are none.
  emptyText: string
  // The count at the foot ("12 items"), or null.
  countText: string | null
  // The figure at the foot right ("Est. value", "1.2b ISK"), or null.
  figure: { label: string; text: string } | null
}

// A character's portrait or a corporation's logo as the card's big picture.
export const portraitPicture = (characterId: number | string): SummaryCard['picture'] => ({
  url: `https://images.evetech.net/characters/${characterId}/portrait?size=256`,
  round: true,
})

export const logoPicture = (corporationId: number | string): SummaryCard['picture'] => ({
  url: `https://images.evetech.net/corporations/${corporationId}/logo?size=256`,
  round: false,
})

const BACKGROUND = '#07090d'
const PANEL = '#10141c'
const MUTED = '#8b93a3'
const TEXT = '#e8ebf1'
const GOLD = '#f2c14e'

const ICON_SIZE = 56
const PICTURE_SIZE = 300

type Images = { picture: string | null; portrait: string | null; icons: Map<string, string | null> }

export const iconKey = (stack: Pick<StackIcon, 'typeId' | 'variation'>) => `${stack.typeId}:${stack.variation}`

const Icon = ({ stack, src }: { stack: StackIcon; src: string | null | undefined }) => (
  <div
    style={{
      display: 'flex',
      position: 'relative',
      width: ICON_SIZE,
      height: ICON_SIZE,
      marginRight: 8,
      marginBottom: 8,
      border: `2px solid ${stack.color}`,
      borderRadius: 6,
      background: PANEL,
    }}
  >
    {src ? <img src={src} width={ICON_SIZE - 4} height={ICON_SIZE - 4} style={{ borderRadius: 4 }} /> : null}
    {stack.count > 1 ? (
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          right: 3,
          bottom: 0,
          fontSize: 16,
          fontWeight: 700,
          color: TEXT,
          textShadow: '0 0 4px #000, 0 0 2px #000',
        }}
      >
        {compactCount(stack.count)}
      </div>
    ) : null}
  </div>
)

const Card = ({ card, images }: { card: SummaryCard; images: Images }) => (
  <div
    style={{
      display: 'flex',
      width: '100%',
      height: '100%',
      padding: 24,
      background: BACKGROUND,
      fontFamily: 'Eve Sans Neue',
      color: TEXT,
    }}
  >
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        border: `3px solid ${card.color}`,
        borderRadius: 14,
        background: `linear-gradient(135deg, ${PANEL} 0%, ${BACKGROUND} 70%)`,
        padding: 28,
      }}
    >
      {/* Left: the subject, and whose it is. */}
      <div style={{ display: 'flex', flexDirection: 'column', width: PICTURE_SIZE, marginRight: 32 }}>
        <div
          style={{
            display: 'flex',
            width: PICTURE_SIZE,
            height: PICTURE_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 10,
            background: PANEL,
          }}
        >
          {images.picture ? (
            <img
              src={images.picture}
              width={card.picture?.round ? 256 : 192}
              height={card.picture?.round ? 256 : 192}
              style={{ borderRadius: card.picture?.round ? 128 : 0 }}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                fontSize: 32,
                color: MUTED,
                textTransform: 'uppercase',
                letterSpacing: 2,
                textAlign: 'center',
              }}
            >
              {card.pictureLabel}
            </div>
          )}
        </div>
        {card.owner ? (
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 22 }}>
            {images.portrait ? (
              <img
                src={images.portrait}
                width={64}
                height={64}
                style={{ borderRadius: card.owner.portrait?.kind === 'character' ? 32 : 6, marginRight: 16 }}
              />
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div
                style={{ display: 'flex', fontSize: 16, color: MUTED, textTransform: 'uppercase', letterSpacing: 1 }}
              >
                Owner
              </div>
              <div style={{ display: 'flex', fontSize: 26, fontWeight: 700 }}>{card.owner.name}</div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Right: the title in its colour, then the icons, then the figures. */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div
          style={{
            display: 'flex',
            fontFamily: 'Eve Sans Neue Expanded',
            fontSize: card.title.length > 22 ? 36 : 46,
            fontWeight: 700,
            color: card.color,
            lineHeight: 1.1,
          }}
        >
          {card.title}
        </div>
        <div style={{ display: 'flex', fontSize: 24, color: MUTED, marginTop: 6, marginBottom: 22 }}>
          {card.subtitle}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', flex: 1 }}>
          {card.stacks.length > 0 ? (
            card.stacks.map((stack) => (
              <Icon key={iconKey(stack)} stack={stack} src={images.icons.get(iconKey(stack))} />
            ))
          ) : (
            <div style={{ display: 'flex', fontSize: 24, color: MUTED }}>{card.emptyText}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {card.countText ? <div style={{ display: 'flex', fontSize: 22, color: TEXT }}>{card.countText}</div> : null}
            <div style={{ display: 'flex', fontSize: 18, color: MUTED }}>edencom.link</div>
          </div>
          {card.figure ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <div
                style={{ display: 'flex', fontSize: 16, color: MUTED, textTransform: 'uppercase', letterSpacing: 1 }}
              >
                {card.figure.label}
              </div>
              <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, color: GOLD }}>{card.figure.text}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  </div>
)

const fetchImages = async (card: SummaryCard): Promise<Images> => {
  const stacks = [...new Map(card.stacks.map((stack) => [iconKey(stack), stack])).values()]
  const [picture, portrait, ...icons] = await Promise.all([
    card.picture ? dataUri(card.picture.url) : Promise.resolve(null),
    card.owner?.portrait ? dataUri(card.owner.portrait.url.replace('size=64', 'size=128')) : Promise.resolve(null),
    ...stacks.map((stack) => dataUri(iconUrl(stack.typeId, stack.variation, 64))),
  ])
  return { picture, portrait, icons: new Map(stacks.map((stack, i) => [iconKey(stack), icons[i]])) }
}

// The card as the PNG a card route answers with.
export const summaryCardResponse = async (card: SummaryCard): Promise<ImageResponse> => {
  const [images, fonts] = await Promise.all([fetchImages(card), cardFonts()])
  return new ImageResponse(<Card card={card} images={images} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts,
    headers: { 'Cache-Control': CARD_CACHE_CONTROL },
  })
}
