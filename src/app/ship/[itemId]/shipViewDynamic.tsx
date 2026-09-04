'use client'

import dynamic from 'next/dynamic'

import { ShipViewSkeleton } from './shipViewSkeleton'

// A `dynamic(…, { ssr: false })` wrapper, for two reasons: `dynamic` with
// `ssr: false` has to be called from a Client Component, and isolating it
// keeps the WASM engine and the several-MB protobuf decode out of every other
// route's bundle.
//
// The skeleton is the view's own empty ring, so the page doesn't reflow when
// the chunk lands — and it's the same one the view shows while it decodes, so
// the two waits look like one.
export const ShipViewDynamic = dynamic(() => import('./shipView').then((m) => m.ShipView), {
  ssr: false,
  loading: () => <ShipViewSkeleton />,
})
