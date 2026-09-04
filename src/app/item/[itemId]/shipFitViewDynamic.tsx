'use client'

import dynamic from 'next/dynamic'

import { FitPlaceholder } from './fitPlaceholder'

// `dynamic(..., { ssr: false })` must be called from a Client Component —
// Turbopack rejects it inside a Server Component page (page.tsx). Isolating
// it here also keeps the fit-viewer's WASM + data payload out of every other
// route's bundle; it only loads when this component is actually rendered.
// The placeholder holds the viewer's footprint while the chunk downloads;
// ShipFitView then keeps its own copy up until the fit data has loaded too.
export const ShipFitViewDynamic = dynamic(() => import('./shipFitView').then((m) => m.ShipFitView), {
  ssr: false,
  loading: FitPlaceholder,
})
