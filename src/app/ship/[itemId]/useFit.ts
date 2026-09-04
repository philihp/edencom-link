'use client'

import { useEffect, useState } from 'react'

import { calculateSlots, type SlotCounts } from './esf/attributes'
import {
  allSkillsAtLevel,
  calculateFit,
  installDataCallbacks,
  loadDogmaEngine,
  type Calculation,
  type Skills,
} from './esf/dogma'
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

// `skills` names the basis: a pilot's own levels, or null for the all-V
// baseline every fitting tool opens with. Changing it recalculates — and
// deliberately leaves the previous `loaded` in place while that happens, so
// flipping the basis updates the numbers rather than blanking the viewer back
// to its skeleton. The SDE and the engine are both module-cached by then, so
// the second pass is just `calculate()`.
export const useFit = (esiFit: EsiFit, skills: Skills | null = null) => {
  const [loaded, setLoaded] = useState<FitCalculation | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true

    const run = async () => {
      const eveData = await loadEveData()
      installDataCallbacks(eveData)
      const dogma = await loadDogmaEngine()

      const fit = esiFitToEsfFit(esiFit, eveData)
      const calculation = calculateFit(dogma, fit, skills ?? allSkillsAtLevel(eveData, 5))

      if (!live) return
      setLoaded({ eveData, fit, calculation, slots: calculateSlots(eveData, calculation) })
    }

    run().catch((thrown) => {
      if (live) setError(thrown instanceof Error ? thrown.message : String(thrown))
    })

    return () => {
      live = false
    }
  }, [esiFit, skills])

  return { loaded, error }
}
