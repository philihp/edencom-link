'use client'

import { useEffect } from 'react'
import type { ReactNode } from 'react'

import {
  CurrentCharacterProvider,
  CurrentFitProvider,
  DefaultCharactersProvider,
  DogmaEngineProvider,
  EveDataProvider,
  ShipFit,
  StatisticsProvider,
  useCurrentCharacter,
  useDogmaEngine,
  useEveData,
  useImportEsiFitting,
  useStatistics,
} from '@eveshipfit/react'
import type { EsiFit } from '@eveshipfit/react'

// DogmaEngineProvider dynamic-imports the @eveshipfit/dogma-engine wasm with
// no .catch(): if the wasm fails to load (bundler wasm handling is the
// historically fragile part), the provider just stays null forever and the
// wheel silently renders without modules, slot arcs, or stats. Import it
// ourselves once — same module, so this costs nothing when it works — purely
// to surface the real error the library swallows.
let probeStarted = false
const probeDogmaEngine = () => {
  if (probeStarted) return
  probeStarted = true
  import('@eveshipfit/dogma-engine').catch((e) => console.error('esf: dogma-engine failed to load:', e))
}

// Module icons on the wheel come from StatisticsProvider's dogma-engine
// output, not the fit itself, so "statistics stuck at null" IS the
// empty-wheel bug. When it persists after the type/dogma data is ready, name
// the dependency that's null so devtools shows where the chain broke.
const EngineDiagnostics = () => {
  const eveData = useEveData()
  const dogmaEngine = useDogmaEngine()
  const { character } = useCurrentCharacter()
  const statistics = useStatistics()

  useEffect(probeDogmaEngine, [])

  useEffect(() => {
    if (eveData === null || statistics !== null) return
    const timer = setTimeout(() => {
      console.warn(
        `esf: fit statistics unavailable — dogma engine ${dogmaEngine === null ? 'NOT loaded' : 'ok'}, ` +
          `character skills ${character?.skills ? 'ok' : 'MISSING'}`
      )
    }, 3000)
    return () => clearTimeout(timer)
  }, [eveData, statistics, dogmaEngine, character])

  return null
}

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
// The character providers are load-bearing even though we never show a
// character picker: StatisticsProvider computes nothing (returns null, so no
// slots and no modules render) unless a current character with skills exists.
// DefaultCharactersProvider provisions synthetic all-skills-L0/L5 characters
// and CurrentCharacterProvider defaults to all-skills-L5 — the standard
// "assume max skills" baseline fitting tools use.
export const ShipFitView = ({ esiFit }: ShipFitViewProps) => (
  <EveDataProvider dataUrl="/esf-data/">
    <DogmaEngineProvider>
      <DefaultCharactersProvider>
        <CurrentCharacterProvider>
          <FitFromEsi esiFit={esiFit}>
            <StatisticsProvider>
              <EngineDiagnostics />
              <div style={{ width: 'min(90vw, 42rem)', aspectRatio: '1' }}>
                <ShipFit withStats readOnly />
              </div>
            </StatisticsProvider>
          </FitFromEsi>
        </CurrentCharacterProvider>
      </DefaultCharactersProvider>
    </DogmaEngineProvider>
  </EveDataProvider>
)
