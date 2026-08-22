'use client'

import { useEffect, useState } from 'react'

import { calculateSlots, type SlotCounts } from './esf/attributes'
import { allSkillsAtLevel, calculateFit, installDataCallbacks, loadDogmaEngine, type Calculation } from './esf/dogma'
import { loadEveData, type EveData } from './esf/eveData'
import { esiFitToEsfFit, type EsfFit, type EsiFit } from './esf/fit'

// Everything the viewer needs before it can draw anything: the decoded SDE,
// the fit the ESI rows describe, and what the dogma engine makes of it.
//
// Browser-only by construction — the engine reads its data off `window` (see
// ./esf/dogma.ts) — so this hook is what the whole view hangs off, and why the
// view is loaded through a `dynamic(…, { ssr: false })` wrapper.
export type FitCalculation = {
  eveData: EveData
  fit: EsfFit
  calculation: Calculation
  slots: SlotCounts
}

export const useFit = (esiFit: EsiFit) => {
  const [loaded, setLoaded] = useState<FitCalculation | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true

    const run = async () => {
      const eveData = await loadEveData()
      installDataCallbacks(eveData)
      const dogma = await loadDogmaEngine()

      // All skills at V: the standard "what can this hull do" baseline, and
      // the one the eveship.fit embed on /ship is pinned to, so the two pages
      // stay comparable. Stage 5 is where the owner's real skills come in.
      const fit = esiFitToEsfFit(esiFit, eveData)
      const calculation = calculateFit(dogma, fit, allSkillsAtLevel(eveData, 5))

      if (!live) return
      setLoaded({ eveData, fit, calculation, slots: calculateSlots(eveData, calculation) })
    }

    run().catch((thrown) => {
      if (live) setError(thrown instanceof Error ? thrown.message : String(thrown))
    })

    return () => {
      live = false
    }
  }, [esiFit])

  return { loaded, error }
}
