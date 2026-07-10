'use client'

import type { ReactNode } from 'react'

import {
  CurrentFitProvider,
  DogmaEngineProvider,
  EveDataProvider,
  ShipFit,
  StatisticsProvider,
  useImportEsiFitting,
} from '@eveshipfit/react'
import type { EsiFit } from '@eveshipfit/react'

type FitFromEsiProps = {
  esiFit: EsiFit
  children: ReactNode
}

// useImportEsiFitting() needs EveDataProvider's type/dogma data loaded before
// it can resolve slots/charges, so it returns null until then. Render nothing
// until it does — CurrentFitProvider only reads its initialFit prop on first
// mount, so it must not mount while the fit is still null.
const FitFromEsi = ({ esiFit, children }: FitFromEsiProps) => {
  const importEsiFitting = useImportEsiFitting()
  const fit = importEsiFitting(esiFit)
  if (!fit) return null
  return <CurrentFitProvider initialFit={fit}>{children}</CurrentFitProvider>
}

type ShipFitViewProps = {
  esiFit: EsiFit
}

// eveship.fit's own hosted data is deliberately CORS-locked to their site, so
// this points at our own build-time mirror (see src/buildEsfData.js).
// ShipFit's root CSS is `width: 100%; height: 100%` — it fills its container,
// and positions its ring elements absolutely within it. Without a sized
// square wrapper it inflates to the whole viewport (the wheel is circular, so
// the container must be square for the rings to line up).
export const ShipFitView = ({ esiFit }: ShipFitViewProps) => (
  <EveDataProvider dataUrl="/esf-data/">
    <DogmaEngineProvider>
      <FitFromEsi esiFit={esiFit}>
        <StatisticsProvider>
          <div style={{ width: 'min(90vw, 42rem)', aspectRatio: '1' }}>
            <ShipFit withStats readOnly />
          </div>
        </StatisticsProvider>
      </FitFromEsi>
    </DogmaEngineProvider>
  </EveDataProvider>
)
