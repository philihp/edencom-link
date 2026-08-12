'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { HEADLINE, calculateSlots, formatAttribute, type SlotCounts } from './esf/attributes'
import { allSkillsAtLevel, calculateFit, installDataCallbacks, loadDogmaEngine, type Calculation } from './esf/dogma'
import { loadEveData } from './esf/eveData'
import { esiFitToEsfFit, type EsfFit, type EsiFit } from './esf/fit'

// Stage 0 of docs/custom-fit-ui.md: no UI, just evidence. Everything the
// eventual fitting view needs that *isn't* look & feel — protobuf decode,
// the WASM engine's data callbacks, the all-skills-V baseline, the ESI
// flag → slot mapping — runs here and dumps what it produced, so the numbers
// can be read side by side with the eveship.fit embed on /ship/[itemId].
//
// Client-only by construction: the engine reads its data off `window`.

type Loaded = {
  fit: EsfFit
  calculation: Calculation
  slots: SlotCounts
  headline: { label: string; value: string; unit?: string }[]
  timings: { data: number; engine: number; calculate: number }
  typeNames: Record<number, string>
}

const useFitCalculation = (esiFit: EsiFit) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true

    const run = async () => {
      const dataStart = performance.now()
      const eveData = await loadEveData()
      const engineStart = performance.now()

      installDataCallbacks(eveData)
      const dogma = await loadDogmaEngine()
      const skills = allSkillsAtLevel(eveData, 5)

      const calculateStart = performance.now()
      const fit = esiFitToEsfFit(esiFit, eveData)
      const calculation = calculateFit(dogma, fit, skills)
      const done = performance.now()

      if (!live) return
      setLoaded({
        fit,
        calculation,
        slots: calculateSlots(eveData, calculation),
        headline: HEADLINE.map((format) => ({
          label: format.label,
          value: formatAttribute(eveData, calculation, format),
          unit: format.unit,
        })),
        timings: {
          data: engineStart - dataStart,
          engine: calculateStart - engineStart,
          calculate: done - calculateStart,
        },
        typeNames: Object.fromEntries(
          [fit.shipTypeId, ...fit.modules.flatMap((m) => [m.typeId, ...(m.charge ? [m.charge.typeId] : [])])].map(
            (typeId) => [typeId, eveData.types[typeId]?.name ?? `#${typeId}`]
          )
        ),
      })
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

// The engine returns attributes as a Map keyed by id, and each carries the
// effects that produced it — the provenance a stats panel will want later.
// JSON.stringify sees a Map as `{}`, so it's reshaped for the dump.
const dumpable = (calculation: Calculation) => {
  const item = (entry: Calculation['hull']) => ({
    ...entry,
    attributes: Object.fromEntries(entry.attributes),
    charge: entry.charge === undefined ? undefined : { ...entry.charge, attributes: undefined },
  })
  return {
    hull: item(calculation.hull),
    items: calculation.items.map(item),
    char: item(calculation.char),
    // Skills are 588 near-identical entries; the count is the interesting part.
    skills: calculation.skills.length,
  }
}

export const FitDebug = ({ esiFit, itemId }: { esiFit: EsiFit; itemId: string }) => {
  const { loaded, error } = useFitCalculation(esiFit)

  if (error) return <pre>Failed: {error}</pre>
  if (!loaded) return <pre>Loading /esf/ data and the dogma engine…</pre>

  return (
    <>
      <h2>Fit</h2>
      <p>
        {loaded.typeNames[loaded.fit.shipTypeId]} — {loaded.fit.modules.length} modules, {loaded.fit.drones.length}{' '}
        drone type(s), {loaded.fit.cargo.length} cargo stack(s). Slots: {loaded.slots.High} high / {loaded.slots.Medium}{' '}
        mid / {loaded.slots.Low} low / {loaded.slots.Rig} rig / {loaded.slots.SubSystem} subsystem,{' '}
        {loaded.slots.Turret} turret and {loaded.slots.Launcher} launcher hardpoints.
      </p>
      <p>
        Decoded 6 protobuf files in {loaded.timings.data.toFixed(0)}ms, loaded the engine in{' '}
        {loaded.timings.engine.toFixed(0)}ms, calculated in {loaded.timings.calculate.toFixed(0)}ms. Skills: all V.
      </p>
      <ul>
        {loaded.fit.modules.map((module, index) => (
          <li key={index}>
            {module.slot.type} {module.slot.index}: {loaded.typeNames[module.typeId]}
            {module.charge ? ` — loaded with ${loaded.typeNames[module.charge.typeId]}` : ''}
          </li>
        ))}
      </ul>

      <h2>Headline attributes</h2>
      <p>
        These are the numbers to read against the eveship.fit embed on{' '}
        <Link href={`/ship/${itemId}`}>/ship/{itemId}</Link>. Damage is the known exception: this stack loads a
        weapon&apos;s ammunition into it, the embed does not (see esf/fit.ts), so a loaded ship reads 0 dps there and a
        real figure here.
      </p>
      <table>
        <tbody>
          {loaded.headline.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>
                {row.value}
                {row.unit ? ` ${row.unit}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Raw calculation</h2>
      <pre style={{ overflow: 'auto', maxHeight: '40rem' }}>
        {JSON.stringify(dumpable(loaded.calculation), null, 2)}
      </pre>
    </>
  )
}
