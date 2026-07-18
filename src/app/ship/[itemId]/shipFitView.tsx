'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'

import {
  CurrentCharacterProvider,
  CurrentFitProvider,
  DefaultCharactersProvider,
  DogmaEngineProvider,
  EveDataProvider,
  FitManagerProvider,
  HardwareListing,
  ShipFit,
  ShipStatistics,
  StatisticsProvider,
  useImportEsiFitting,
} from '@eveshipfit/react'
import type { EsiFit } from '@eveshipfit/react'

import styles from './shipFit.module.css'

// eveship.fit computes fit statistics (and thus which module icons land on the
// wheel's slots) against a character's skills. It picks the character from the
// localStorage key `currentCharacter`, preferring any stored value over the
// prop default, and DefaultCharactersProvider only provisions the two synthetic
// ids `.all-0` / `.all-5`. We never render a character picker on this page, so a
// `currentCharacter` value that isn't `.all-5` (a stale/foreign selection left
// by another eveship.fit embed on this origin) resolves to no character → no
// skills → null statistics → a wheel with no modules. Own the key: normalize it
// to all-skills-L5 before the providers first read it. Runs client-only
// (ShipFitView is dynamic ssr:false) and tolerates storage being unavailable.
const DEFAULT_CHARACTER_ID = '.all-5'
const ensureDefaultCharacter = () => {
  if (typeof window === 'undefined') return
  try {
    const want = JSON.stringify(DEFAULT_CHARACTER_ID)
    if (window.localStorage.getItem('currentCharacter') !== want) {
      window.localStorage.setItem('currentCharacter', want)
    }
  } catch {
    // Storage disabled/full (private mode): the initialCharacterId prop below
    // is still applied as the fallback default, so all-L5 holds for fresh loads.
  }
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
// EveDataProvider points at our own build-time mirror (see src/buildEsfData.js).
// `ShipFit` is only the fitting wheel (slots + CPU/PG/rig usage arcs); the
// numeric readout (EHP, DPS, resistances, capacitor, speed, targeting, drones)
// is the separate `ShipStatistics` component, rendered alongside it here — both
// read the same StatisticsProvider output.
//
// The character providers are load-bearing even though we never show a
// character picker: StatisticsProvider computes nothing (returns null, so no
// slots and no modules render) unless a current character with skills exists.
// DefaultCharactersProvider provisions synthetic all-skills-L0/L5 characters;
// we pin all-skills-L5 both via initialCharacterId (fresh-load default) and by
// normalizing the localStorage key first (which otherwise wins) — the standard
// "assume max skills" baseline fitting tools use.
//
// The wheel is interactive for every viewer (owner and anonymous share-token
// alike): modules/charges can be dragged from the hardware browser onto slots
// to simulate a fit (e.g. loading ammo to see DPS). Edits are client-side only
// — nothing is ever written back to ESI — so there's no reason to gate it.
export const ShipFitView = ({ esiFit }: ShipFitViewProps) => {
  // Lazy initializer: runs once, synchronously, on first render — before the
  // child CurrentCharacterProvider reads localStorage in its own initializer.
  useState(ensureDefaultCharacter)

  // /esf/ serves the .pb2 from the esf_data table (refreshed by the
  // sde-mirror workflow), not the build-time static /esf-data/ files —
  // see src/app/esf/[file]/route.ts.
  return (
    <EveDataProvider dataUrl="/esf/">
      <DogmaEngineProvider>
        <DefaultCharactersProvider>
          <CurrentCharacterProvider initialCharacterId={DEFAULT_CHARACTER_ID}>
            <FitFromEsi esiFit={esiFit}>
              <StatisticsProvider>
                {/* FitManagerProvider must sit inside CurrentFit/Statistics/
                    EveData (all above). It backs the drag-to-fit interactions:
                    dragging a charge from HardwareListing onto a weapon slot
                    calls setCharge, and the stats/wheel recompute live. */}
                <FitManagerProvider>
                  <div className={styles.layout}>
                    <div className={styles.wheel}>
                      <ShipFit withStats />
                    </div>
                    <div className={styles.stats}>
                      <ShipStatistics />
                    </div>
                  </div>
                  <details className={styles.hardware}>
                    <summary>Load modules &amp; ammo (simulate)</summary>
                    <p className={styles.hardwareHint}>
                      Drag a charge onto a weapon slot to load ammo and see damage update. Changes here are a local
                      simulation and are never saved back to the game.
                    </p>
                    <div className={styles.hardwareListing}>
                      <HardwareListing />
                    </div>
                  </details>
                </FitManagerProvider>
              </StatisticsProvider>
            </FitFromEsi>
          </CurrentCharacterProvider>
        </DefaultCharactersProvider>
      </DogmaEngineProvider>
    </EveDataProvider>
  )
}
