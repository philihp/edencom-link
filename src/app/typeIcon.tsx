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
import styles from './typeIcon.module.css'

// The variation vocabulary, the priority lists and the category rule all live
// in ./iconVariation.ts — a pure, tested module that server code imports
// directly rather than through this client boundary.
export type { IconVariation } from './iconVariation'

// What CCP holds for each type id we have had to ask about, shared by every
// icon on the page. Module scope, so the answer is fetched once per type per
// page load however many rows show it; `inFlight` collapses a burst of
// simultaneous misses (a table of fifty identical relics) into one request.
const known = new Map<number, IconVariation[]>()
const inFlight = new Map<number, Promise<IconVariation[]>>()

const loadVariations = (typeID: number): Promise<IconVariation[]> => {
  const cached = known.get(typeID)
  if (cached) return Promise.resolve(cached)
  const existing = inFlight.get(typeID)
  if (existing) return existing
  const request = fetch(variationsUrl(typeID))
    .then((r) => (r.ok ? r.json() : []))
    .then(parseVariations)
    .catch(() => [] as IconVariation[])
    .then((variations) => {
      if (variations.length > 0) known.set(typeID, variations)
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
  // sharpens the opening guess; the component corrects itself either way.
  categoryID?: number | null
  // Extra class, for the few icons that aren't the inline-beside-a-name shape
  // the module's own class assumes (the ship page's big hull render).
  className?: string
}

// The item icon CCP's image server serves for a type id.
//
// Resolution is seed-then-verify. The first paint uses the category's implied
// variation (iconVariation) — right for effectively every type, and the only
// thing available during the server render, so there is no placeholder flash
// and no request storm: a 200-row asset table costs zero extra round trips in
// the common case. Should that guess 400 — CCP holds no such artwork — the
// component asks GET /types/{id} for the real list and picks from it by the
// caller's priority order. So the category rule is an optimisation, never a
// correctness assumption, and a type it gets wrong self-heals.
//
// Purely decorative: every use sits next to the type's name (TypeName), so it
// carries an empty alt and is hidden from screen readers rather than repeating
// it. Not a next/image — plain <img> keeps images.evetech.net out of
// next.config.mjs's remote patterns.
export const TypeIcon = ({ id, size = 24, prefer, isBlueprintCopy, categoryID, className }: TypeIconProps) => {
  const preference = preferenceFor(prefer, isBlueprintCopy)

  // Deterministic across server and client — the module cache is deliberately
  // NOT consulted here, since it would differ between the two renders and
  // desynchronise hydration. The effect below applies it a tick later.
  const [variation, setVariation] = useState<IconVariation>(() => iconVariation(categoryID, isBlueprintCopy))
  // One correction per mounted icon: without this, a variation that is itself
  // missing would re-enter onError and loop on the same fetch.
  const corrected = useRef(false)

  const apply = (available: IconVariation[]) => {
    const best = pickVariation(available, preference)
    if (best) setVariation(best)
  }

  // A type an earlier icon already asked about needs no second 400 to discover
  // the same answer, so adopt what is already known as soon as we are on the
  // client.
  useEffect(() => {
    const cached = known.get(id)
    if (cached && !corrected.current) {
      corrected.current = true
      apply(cached)
    }
    // preference is rebuilt each render; the identity that matters is the type.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const onError = () => {
    if (corrected.current) return
    corrected.current = true
    void loadVariations(id).then(apply)
  }

  return (
    <img
      className={className ? `${styles.icon} ${className}` : styles.icon}
      src={iconUrl(id, variation, size)}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      loading="lazy"
      onError={onError}
    />
  )
}
