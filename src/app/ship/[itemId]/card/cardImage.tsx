import { compactIsk, type CardIcon, type CardRow } from './cardModel'
import type { ShipCard } from './loadCard'

// The ship link-preview card as JSX for next/og (Satori). Satori draws only
// flexbox and a subset of CSS, so every element with more than one child is
// display: flex, and every <img> is a data: URI the route fetched first.

const BACKGROUND = '#07090d'
const PANEL = '#10141c'
const MUTED = '#8b93a3'
const TEXT = '#e8ebf1'
const GOLD = '#f2c14e'

const ICON_SIZE = 52

export type Images = { render: string | null; portrait: string | null; icons: Map<number, string | null> }

const Icon = ({ icon, src }: { icon: CardIcon; src: string | null | undefined }) => (
  <div
    style={{
      display: 'flex',
      position: 'relative',
      width: ICON_SIZE,
      height: ICON_SIZE,
      marginRight: 8,
      border: `2px solid ${icon.color}`,
      borderRadius: 6,
      background: PANEL,
    }}
  >
    {src ? <img src={src} width={ICON_SIZE - 4} height={ICON_SIZE - 4} style={{ borderRadius: 4 }} /> : null}
    {icon.count > 1 ? (
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          right: 2,
          bottom: 0,
          fontSize: 16,
          fontWeight: 700,
          color: TEXT,
          textShadow: '0 0 4px #000, 0 0 2px #000',
        }}
      >
        {`×${icon.count}`}
      </div>
    ) : null}
  </div>
)

const Row = ({ row, icons }: { row: CardRow; icons: Map<number, string | null> }) => (
  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
    <div
      style={{
        display: 'flex',
        width: 120,
        fontSize: 18,
        color: MUTED,
        textTransform: 'uppercase',
        letterSpacing: 1,
      }}
    >
      {row.label}
    </div>
    {row.icons.map((icon, i) => (
      <Icon key={`${icon.typeId}-${i}`} icon={icon} src={icons.get(icon.typeId)} />
    ))}
  </div>
)

export const Card = ({ card, images }: { card: ShipCard; images: Images }) => (
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
      {/* Left: the hull, as the in-game info window leads with it, and whose
          it is. */}
      <div style={{ display: 'flex', flexDirection: 'column', width: 400, marginRight: 32 }}>
        <div style={{ display: 'flex', width: 400, height: 400, borderRadius: 10, background: PANEL }}>
          {images.render ? <img src={images.render} width={400} height={400} style={{ borderRadius: 10 }} /> : null}
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
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 16, color: MUTED, textTransform: 'uppercase', letterSpacing: 1 }}>
              Owner
            </div>
            <div style={{ display: 'flex', fontSize: 28, fontWeight: 700 }}>{card.owner.name}</div>
          </div>
        </div>
      </div>

      {/* Right: the name in its tier colour, then the fit, then the value. */}
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
          {card.groupName ? `${card.typeName} · ${card.groupName}` : card.typeName}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          {card.rows.map((row) => (
            <Row key={row.label} row={row} icons={images.icons} />
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', fontSize: 18, color: MUTED }}>edencom.link</div>
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
