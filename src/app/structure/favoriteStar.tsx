'use client'

import { useOptimistic, useTransition } from 'react'

import { toggleFavorite } from './favorites'
import styles from './structures.module.css'

// The pin control on a structure tile. Favorites sort to the top of the page,
// so the whole point of the star is that clicking it moves the tile — which
// makes the round trip very visible. useOptimistic flips the star immediately
// and React reverts it if the action throws, so the star never sits in the
// old state while the re-sorted page is on its way.
export const FavoriteStar = ({ structureId, favorite }: { structureId: string; favorite: boolean }) => {
  const [pending, startTransition] = useTransition()
  const [optimistic, setOptimistic] = useOptimistic(favorite)

  return (
    <button
      type="button"
      className={styles.favorite}
      aria-pressed={optimistic}
      aria-label={optimistic ? 'Remove from favorites' : 'Add to favorites'}
      title={optimistic ? 'Remove from favorites' : 'Add to favorites'}
      data-pending={pending || undefined}
      onClick={() =>
        startTransition(async () => {
          setOptimistic(!optimistic)
          await toggleFavorite(structureId, !optimistic)
        })
      }
    >
      {optimistic ? '★' : '☆'}
    </button>
  )
}
