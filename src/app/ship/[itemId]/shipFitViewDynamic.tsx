'use client'

import dynamic from 'next/dynamic'

// `dynamic(..., { ssr: false })` must be called from a Client Component —
// Turbopack rejects it inside a Server Component page (page.tsx). Isolating
// it here also keeps the fit-viewer's WASM + data payload out of every other
// route's bundle; it only loads when this component is actually rendered.
export const ShipFitViewDynamic = dynamic(() => import('./shipFitView').then((m) => m.ShipFitView), { ssr: false })
