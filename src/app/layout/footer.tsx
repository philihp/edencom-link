import Link from 'next/link'

import { DateTime } from '../DateTime'
import styles from './footer.module.css'

const REPO = 'https://github.com/philihp/edencom-link'

const Footer = () => {
  const buildTime = process.env.BUILD_TIME
  const sha = process.env.COMMIT_SHA

  return (
    <>
      <hr />
      <footer className={styles.footer}>
        Made with love by Sir Cuddles
        {buildTime ? (
          <>
            {' — '}
            <DateTime value={buildTime} />
          </>
        ) : null}
        {sha ? (
          <>
            {' · '}
            <a href={`${REPO}/commit/${sha}`}>{sha.slice(0, 7)}</a>
          </>
        ) : null}
        <span className={styles.links}>
          <Link href="/privacy">Privacy</Link>
          {' · '}
          <Link href="/terms">Terms</Link>
        </span>
      </footer>
    </>
  )
}

export default Footer
