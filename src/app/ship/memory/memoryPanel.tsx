import type { ComponentProps } from 'react'
import Markdown from 'react-markdown'

import { DateTime } from '../../DateTime'
import type { ShipMemory } from './read'
import styles from './memory.module.css'

// The Memory panel below the fitting stack on /ship/[itemId]
// (docs/ship-memory.md, "Display"): the ship's own text, as its AI wrote it,
// rendered from markdown. Nothing when the ship has no memory.
//
// The text is written by whichever AI the holder uses, over MCP, and is read
// by everyone the ship's share reaches, so it is treated as untrusted: raw
// HTML is dropped (react-markdown never renders it; skipHtml drops the text
// of it too), links open in a new tab with rel="nofollow noopener", and
// images are not drawn at all (an image URL would send every reader's
// address to whoever hosts it; the text keeps the alt as plain words).

const Link = ({ href, children }: ComponentProps<'a'>) => (
  <a href={href} rel="nofollow noopener noreferrer" target="_blank">
    {children}
  </a>
)

export const MemoryPanel = ({ memory }: { memory: ShipMemory | null }) => {
  if (memory == null) return null
  return (
    <section className={styles.memory} aria-labelledby="ship-memory-heading">
      <div className={styles.head}>
        <h2 id="ship-memory-heading" className={styles.heading}>
          Memory
        </h2>
        <p className={styles.meta}>
          written {memory.versions === 1 ? 'once' : `${memory.versions} times`}, last on{' '}
          <DateTime value={memory.lastWritten} /> by {memory.author}
        </p>
      </div>
      <div className={styles.body}>
        <Markdown skipHtml disallowedElements={['img']} unwrapDisallowed components={{ a: Link }}>
          {memory.body}
        </Markdown>
      </div>
      <p className={styles.note}>Goes with the ship if you sell it.</p>
    </section>
  )
}
