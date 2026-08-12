'use client'

import dynamic from 'next/dynamic'

// Same shape as shipFitViewDynamic.tsx, and for the same two reasons:
// `dynamic(..., { ssr: false })` has to be called from a Client Component, and
// isolating it keeps the WASM engine and the several-MB protobuf decode out of
// every other route's bundle. There's nothing to hold space for here — the
// page renders text — so the loading state is a line of text.
export const FitDebugDynamic = dynamic(() => import('./fitDebug').then((m) => m.FitDebug), {
  ssr: false,
  loading: () => <pre>Loading the fit engine…</pre>,
})
