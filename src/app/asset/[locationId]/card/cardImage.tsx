import { compactIsk } from '../../../ship/[itemId]/card/cardModel'
import { compactCount, itemCountText, type StackIcon } from './cardModel'
import type { AssetCard } from './loadCard'

// The container link-preview card as JSX for next/og (Satori), in the ship
// card's look (ship/[itemId]/card/cardImage.tsx): the container's picture and
// owner on the left, its name in its tier colour and its contents as a grid
// of icons on the right, the value at the foot. Satori draws only flexbox and
// a subset of CSS, so every element with more than one child is display: flex,
// and every <img> is a data: URI the route fetched first.

const BACKGROUND = '#07090d'
const PANEL = '#10141c'
const MUTED = '#8b93a3'
const TEXT = '#e8ebf1'
const GOLD = '#f2c14e'

const ICON_SIZE = 56
const PICTURE_SIZE = 300

export type Images = { picture: string | null; portrait: string | null; icons: Map<string, string | null> }

// The line under the title: type and group, without repeating a title that
// already is the type name.
const subtitle = ({ title, typeName, groupName }: AssetCard): string =>
  [title === typeName ? null : typeName, groupName === typeName ? null : groupName]
    .filter((part) => part != null)
    .join(' · ')

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

export const Card = ({ card, images }: { card: AssetCard; images: Images }) => (
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
      {/* Left: the container, and whose it is. */}
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
          {/* A station or a solar system has no type art to draw, so it shows
              what kind of place it is instead. */}
          {images.picture ? (
            <img src={images.picture} width={192} height={192} />
          ) : card.typeId == null ? (
            <div style={{ display: 'flex', fontSize: 32, color: MUTED, textTransform: 'uppercase', letterSpacing: 2 }}>
              {card.typeName}
            </div>
          ) : null}
        </div>
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
            <div style={{ display: 'flex', fontSize: 16, color: MUTED, textTransform: 'uppercase', letterSpacing: 1 }}>
              Owner
            </div>
            <div style={{ display: 'flex', fontSize: 26, fontWeight: 700 }}>{card.owner.name}</div>
          </div>
        </div>
      </div>

      {/* Right: the name in its tier colour, then what is inside, then the value. */}
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
          {subtitle(card)}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', flex: 1 }}>
          {card.stacks.length > 0 ? (
            card.stacks.map((stack) => (
              <Icon key={iconKey(stack)} stack={stack} src={images.icons.get(iconKey(stack))} />
            ))
          ) : (
            <div style={{ display: 'flex', fontSize: 24, color: MUTED }}>Empty</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {card.itemCount > 0 ? (
              <div style={{ display: 'flex', fontSize: 22, color: TEXT }}>{itemCountText(card.itemCount)}</div>
            ) : null}
            <div style={{ display: 'flex', fontSize: 18, color: MUTED }}>edencom.link</div>
          </div>
          {card.value.sell != null ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <div
                style={{ display: 'flex', fontSize: 16, color: MUTED, textTransform: 'uppercase', letterSpacing: 1 }}
              >
                {card.value.unpriced > 0 ? 'Est. value (partial)' : 'Est. value'}
              </div>
              <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, color: GOLD }}>
                {compactIsk(card.value.sell)}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  </div>
)
