import styles from './typeIcon.module.css'

// Which image CCP's server holds for a type. Most types have "icon"; blueprints
// have only "bp"/"bpc" (a blueprint request for "icon" is a 400, not a
// fallback), and ships additionally have the big "render". Callers that know a
// row is a blueprint pass the matching variation — see blueprintIcon below.
export type IconVariation = 'icon' | 'bp' | 'bpc' | 'render'

type TypeIconProps = {
  id: number
  // Rendered size in CSS pixels; the image itself is always fetched at 64 so a
  // hi-dpi screen has pixels to spare at the sizes used here.
  size?: number
  variation?: IconVariation
}

// The image variation for a blueprint stack: originals and copies have distinct
// artwork, and neither answers to "icon".
export const blueprintIcon = (isCopy: boolean | null | undefined): IconVariation => (isCopy ? 'bpc' : 'bp')

// The item icon CCP's image server serves for a type id. Purely decorative —
// every use sits next to the type's name (TypeName), so it carries an empty alt
// and is hidden from screen readers rather than repeating that name. Not a
// next/image: the existing icon/portrait uses across the app are plain <img>
// tags, which keeps images.evetech.net out of next.config.mjs's remote patterns.
export const TypeIcon = ({ id, size = 24, variation = 'icon' }: TypeIconProps) => (
  <img
    className={styles.icon}
    src={`https://images.evetech.net/types/${id}/${variation}?size=64`}
    alt=""
    aria-hidden="true"
    width={size}
    height={size}
    loading="lazy"
  />
)
