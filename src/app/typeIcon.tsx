import styles from './typeIcon.module.css'

type TypeIconProps = {
  id: number
  // Rendered size in CSS pixels; the image itself is always fetched at 64 so a
  // hi-dpi screen has pixels to spare at the sizes used here.
  size?: number
}

// The item icon CCP's image server serves for a type id. Purely decorative —
// every use sits next to the type's name (TypeName), so it carries an empty alt
// and is hidden from screen readers rather than repeating that name. Not a
// next/image: the existing icon/portrait uses across the app are plain <img>
// tags, which keeps images.evetech.net out of next.config.mjs's remote patterns.
export const TypeIcon = ({ id, size = 24 }: TypeIconProps) => (
  <img
    className={styles.icon}
    src={`https://images.evetech.net/types/${id}/icon?size=64`}
    alt=""
    aria-hidden="true"
    width={size}
    height={size}
    loading="lazy"
  />
)
