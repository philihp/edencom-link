// A question-mark-in-a-circle that explains the numbers around it on hover
// (and on keyboard focus — it's a real focusable element, not just a title
// attribute, so the explanation is reachable without a mouse). Pure markup +
// CSS, so it renders on the server like the rest of the tile.
import styles from './structures.module.css'

export const HelpTip = ({ text }: { text: string }) => (
  <span className={styles.helpTip} tabIndex={0} aria-label={text}>
    ?
    <span className={styles.helpTipBody} role="tooltip">
      {text}
    </span>
  </span>
)
