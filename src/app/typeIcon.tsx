import { iconVariation, type IconVariation } from './iconVariation'
import styles from './typeIcon.module.css'

// The variation vocabulary and the category rule live in ./iconVariation.ts (a
// pure, tested module); re-exported here so callers keep their single
// '@/app/typeIcon' import.
export { blueprintIcon, iconVariation, type IconVariation } from './iconVariation'

type TypeIconProps = {
  id: number
  // Rendered size in CSS pixels; the image is fetched at the power-of-two
  // above it (see fetchSize) so a hi-dpi screen has pixels to spare.
  size?: number
  // The variation to request. Pass it when the caller knows better than the
  // category rule can — a ship's "render", or a blueprint copy's "bpc" where
  // the row says so. Omitted, it is derived from `categoryID`.
  variation?: IconVariation
  // The type's SDE category, for callers holding the resolved SdeType (most do
  // — they needed it for the name anyway). Ignored when `variation` is given.
  // With neither, the request falls back to "icon", which is right for
  // everything outside the two special categories.
  categoryID?: number | null
  // Extra class, for the few icons that aren't the inline-beside-a-name shape
  // the module's own class assumes (the ship page's big hull render).
  className?: string
}

// CCP's image server serves fixed power-of-two sizes; ask for the one that
// still has pixels to spare at 2× the rendered size.
const fetchSize = (size: number) => (size <= 32 ? 64 : size <= 64 ? 128 : size <= 128 ? 256 : 512)

// The item icon CCP's image server serves for a type id. Purely decorative —
// every use sits next to the type's name (TypeName), so it carries an empty alt
// and is hidden from screen readers rather than repeating that name. Not a
// next/image: the existing icon/portrait uses across the app are plain <img>
// tags, which keeps images.evetech.net out of next.config.mjs's remote patterns.
export const TypeIcon = ({ id, size = 24, variation, categoryID, className }: TypeIconProps) => (
  <img
    className={className ? `${styles.icon} ${className}` : styles.icon}
    src={`https://images.evetech.net/types/${id}/${variation ?? iconVariation(categoryID)}?size=${fetchSize(size)}`}
    alt=""
    aria-hidden="true"
    width={size}
    height={size}
    loading="lazy"
  />
)
