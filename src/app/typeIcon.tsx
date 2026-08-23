'use client'

import { useEffect, useRef, useState } from 'react'

import {
  iconUrl,
  iconVariation,
  parseVariations,
  pickVariation,
  preferenceFor,
  variationsUrl,
  type IconVariation,
} from './iconVariation'
import { readVariations, writeVariations } from './iconVariationCache'
import styles from './typeIcon.module.css'

// The variation vocabulary, the priority lists and the category rule all live
// in ./iconVariation.ts — a pure, tested module that server code imports
// directly rather than through this client boundary.
export type { IconVariation } from './iconVariation'

// Collapses a burst of simultaneous misses on one type (a table of fifty
// identical relics) into a single request. The answers themselves live in
// ./iconVariationCache, which outlives the page.
const inFlight = new Map<number, Promise<IconVariation[]>>()

const loadVariations = (typeID: number): Promise<IconVariation[]> => {
  const cached = readVariations(typeID)
  if (cached) return Promise.resolve(cached)
  const existing = inFlight.get(typeID)
  if (existing) return existing
  const request = fetch(variationsUrl(typeID))
    .then((r) => (r.ok ? r.json() : []))
    .then(parseVariations)
    .catch(() => [] as IconVariation[])
    .then((variations) => {
      writeVariations(typeID, variations)
      inFlight.delete(typeID)
      return variations
    })
  inFlight.set(typeID, request)
  return request
}

type TypeIconProps = {
  id: number
  // Rendered size in CSS pixels; the image is fetched at the power-of-two above
  // it so a hi-dpi screen has pixels to spare.
  size?: number
  // Which variations this caller wants, best first. A bare string is the same
  // as a one-entry list. The house order (icon, then the blueprint/relic
  // artwork, then render) follows whatever is given, so a hint can never leave
  // a type with nothing to show — see preferenceFor.
  prefer?: IconVariation | readonly IconVariation[] | null
  // Known to be a blueprint COPY, which flips the bp/bpc preference. Only
  // meaningful for blueprint-category rows.
  isBlueprintCopy?: boolean | null
  // The type's SDE category, for callers holding the resolved SdeType. Only
  // sharpens the opening guess for a type we have never seen.
  categoryID?: number | null
  // Extra class, for the few icons that aren't the inline-beside-a-name shape
  // the module's own class assumes (the ship page's big hull render).
  className?: string
}

// Cache first, guess only if we must. Returns the variation to request now:
// the best of what this type is KNOWN to have, or — for a type never seen
// before — what its category implies.
//
// On the server there is no localStorage, so this always falls to the guess,
// which is what keeps the server render deterministic.
const resolveVariation = (
  id: number,
  preference: readonly IconVariation[],
  categoryID: number | null | undefined,
  isBlueprintCopy: boolean | null | undefined
): IconVariation => {
  const known = readVariations(id)
  return (known && pickVariation(known, preference)) || iconVariation(categoryID, isBlueprintCopy)
}

// The item icon CCP's image server serves for a type id.
//
// Asking for a variation a type does not have is a 400, not a fallback, so the
// job is to never ask. Resolution has three tiers:
//
//  1. The type's variation list is already cached (this page, an earlier
//     navigation, or a previous visit) — pick from it by the caller's priority
//     order. No request beyond the image itself, and never a 400.
//  2. Never seen before — request what the SDE category implies, which is right
//     for effectively every type and is all a server render can do.
//  3. That guess 400s — ask GET /types/{id} for the real list, pick from it,
//     and remember it, so tier 1 covers this type from then on.
//
// Purely decorative: every use sits next to the type's name (TypeName), so it
// carries an empty alt and is hidden from screen readers rather than repeating
// it. Not a next/image — plain <img> keeps images.evetech.net out of
// next.config.mjs's remote patterns.
export const TypeIcon = ({ id, size = 24, prefer, isBlueprintCopy, categoryID, className }: TypeIconProps) => {
  const preference = preferenceFor(prefer, isBlueprintCopy)

  const [variation, setVariation] = useState<IconVariation>(() =>
    resolveVariation(id, preference, categoryID, isBlueprintCopy)
  )
  // One correction per type shown: without it, a variation that is itself
  // missing would re-enter onError and loop on the same fetch.
  const corrected = useRef(false)

  // A row reused for a different type (paging, filtering, a virtualised list)
  // keeps this component mounted, so the resolved variation has to follow the
  // prop. Adjusting state during render rather than in an effect — React's
  // documented pattern for exactly this, and it avoids painting the old type's
  // artwork for a frame.
  const [renderedId, setRenderedId] = useState(id)
  if (renderedId !== id) {
    setRenderedId(id)
    corrected.current = false
    setVariation(resolveVariation(id, preference, categoryID, isBlueprintCopy))
  }

  const onError = () => {
    if (corrected.current) return
    corrected.current = true
    void loadVariations(id).then((available) => {
      const best = pickVariation(available, preference)
      if (best) setVariation(best)
    })
  }

  // On a hard load the server rendered its guess, and the cache may say
  // otherwise. React does not reliably patch a mismatched attribute during
  // hydration — it can keep the server's value even though our state already
  // holds the cached answer — so reconcile the DOM with state explicitly. A
  // no-op whenever they agree, which is the usual case.
  const img = useRef<HTMLImageElement>(null)
  const src = iconUrl(id, variation, size)
  useEffect(() => {
    const el = img.current
    if (el && el.getAttribute('src') !== src) el.setAttribute('src', src)
  }, [src])

  return (
    <img
      ref={img}
      className={className ? `${styles.icon} ${className}` : styles.icon}
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      loading="lazy"
      // The cache can make the client's first choice differ from the server's
      // guess. That is the feature, not a bug to warn about.
      suppressHydrationWarning
      onError={onError}
    />
  )
}
