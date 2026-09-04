'use client'

import { useState } from 'react'

import { TypeIcon } from '../../typeIcon'
import styles from './shipView.module.css'
import {
  DAMAGE_TYPES,
  RESIST_LAYERS,
  STAT_GROUPS,
  fittingResources,
  formatAttribute,
  resistFormat,
} from './esf/attributes'
import type { EsiFit, SlotType } from './esf/fit'
import { groupBays, slotSections, type Bay, type BayRow, type ModuleGroup } from './panels'
import { ringCells } from './ring'
import { ShipViewSkeleton } from './shipViewSkeleton'
import type { PilotSkills } from './pilotSkills'
import { useFit, type FitCalculation } from './useFit'

// The ship viewer: the fitting ring, what's fitted to it, what's aboard, and
// what the dogma engine makes of the whole thing. Stages 2 and 3 of
// docs/custom-fit-ui.md — our own components over our own fitting stack, in
// place of the eveship.fit embed, which /item/[itemId] still renders until
// stage 4 phase 3 retires it.
//
// One component tree serves both layouts. On a phone the three panels are
// tabs; from 900px up the tab bar disappears and all three are simply on the
// page, the ring beside its slot listing (see shipView.module.css). The tab
// state is kept either way — it costs nothing, and it means no width probing
// at render time, which would have to guess before hydration.

type Tab = 'fit' | 'cargo' | 'info'

// Which skill sheet the numbers are calculated against.
type Basis = 'pilot' | 'all-v'

const TABS: [Tab, string][] = [
  ['fit', 'fit'],
  ['cargo', 'cargo'],
  ['info', 'info'],
]

// Volumes run from a round of ammunition to a freighter's hold, so they're
// grouped and capped at two decimals rather than printed raw — the same rule
// the asset table's volume column uses.
const formatVolume = (m3: number): string => m3.toLocaleString('en-US', { maximumFractionDigits: 2 })

const formatCount = (count: number): string => count.toLocaleString('en-US')

// A resource bar is drawn against its own cap, so anything at or over it is
// pinned at full width; the colour is what says which of the two happened.
const barWidth = (used: number, total: number): string =>
  `${total <= 0 ? 0 : Math.min(100, Math.round((used / total) * 100))}%`

const barTone = (used: number, total: number): string =>
  total > 0 && used > total ? styles.over : total > 0 && used / total >= 0.95 ? styles.tight : ''

export const ShipView = ({ esiFit, pilot }: { esiFit: EsiFit; pilot?: PilotSkills | null }) => {
  // The pilot's own skills are the basis when we have them — that is the
  // point of reading them — with all-V one click away, since it is the basis
  // every other fitting tool quotes and the one a fit gets shared under.
  const [basis, setBasis] = useState<Basis>('pilot')
  const skills = pilot && basis === 'pilot' ? pilot.levels : null
  const { loaded, error } = useFit(esiFit, skills)
  const [tab, setTab] = useState<Tab>('fit')

  if (error) return <p className={styles.failed}>The fitting stack could not read this ship: {error}</p>
  if (!loaded) return <ShipViewSkeleton />

  const bays = groupBays(
    // Everything carried rather than fitted. A charge loaded into a weapon
    // carries its slot's flag, so it is already drawn in that slot and must
    // not be counted a second time as cargo.
    esiFit.items.flatMap<BayRow>((item) =>
      typeof item.flag === 'string' && !/^(Hi|Med|Lo|Rig|SubSystem)Slot/.test(item.flag)
        ? [{ typeId: item.type_id, flag: item.flag, quantity: item.quantity }]
        : []
    ),
    (typeId) => loaded.eveData.types[typeId]?.volume,
    (attribute) => {
      const id = loaded.eveData.attributeMapping[attribute]
      return id === undefined ? 0 : (loaded.calculation.hull.attributes.get(id)?.value ?? 0)
    }
  )
  const aboard = bays.reduce((total, bay) => total + bay.items.length, 0)

  return (
    <div className={styles.viewer}>
      <div className={styles.tabs} role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={styles.tab}
            data-active={tab === id ? '' : undefined}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'cargo' && aboard > 0 ? <span className={styles.tabCount}>{aboard}</span> : null}
          </button>
        ))}
      </div>

      <section className={styles.panel} data-active={tab === 'fit' ? '' : undefined}>
        <FitPanel loaded={loaded} />
      </section>
      <section className={styles.panel} data-active={tab === 'cargo' ? '' : undefined}>
        <BayPanel bays={bays} eveData={loaded.eveData} />
      </section>
      <section className={styles.panel} data-active={tab === 'info' ? '' : undefined}>
        <StatsPanel loaded={loaded} pilot={pilot} basis={basis} onBasis={setBasis} />
      </section>
    </div>
  )
}

// The ring and its slot listing, which are two views of one thing: the ring
// says where a module sits, the list says what it is.
const FitPanel = ({ loaded }: { loaded: FitCalculation }) => {
  const sections = slotSections(loaded.fit.modules, loaded.slots)
  const resources = fittingResources(loaded.eveData, loaded.calculation)

  return (
    <div className={styles.fitLayout}>
      <Ring loaded={loaded} />
      <div className={styles.fitColumn}>
        <div className={styles.resources}>
          {resources.map((resource) => (
            <div key={resource.label} className={styles.resource}>
              <span className={styles.legend}>{resource.label}</span>
              <span className={styles.track}>
                <span
                  className={`${styles.fill} ${barTone(resource.used, resource.total)}`}
                  style={{ width: barWidth(resource.used, resource.total) }}
                />
              </span>
              <span className={styles.resourceValue}>
                {formatVolume(resource.used)} / {formatVolume(resource.total)}
                {resource.unit ? ` ${resource.unit}` : ''}
              </span>
            </div>
          ))}
        </div>
        <div className={styles.slotList}>
          {sections.map((section) => (
            <div key={section.family} className={styles.slotSection}>
              <h3 className={styles.legend} data-family={section.family}>
                {section.label}
                <span className={styles.slotCount}>
                  {section.fitted}/{section.total}
                </span>
              </h3>
              {section.groups.length === 0 ? (
                <p className={styles.emptySection}>nothing fitted</p>
              ) : (
                <ul className={styles.moduleList}>
                  {section.groups.map((group) => (
                    <ModuleLine key={`${group.typeId}:${group.chargeTypeId}`} group={group} loaded={loaded} />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const ModuleLine = ({ group, loaded }: { group: ModuleGroup; loaded: FitCalculation }) => (
  <li className={styles.module}>
    <TypeIcon id={group.typeId} size={24} className={styles.moduleIcon} />
    <span className={styles.moduleName}>
      <span className="serif">{typeName(loaded, group.typeId)}</span>
      {group.chargeTypeId === null ? null : (
        <span className={styles.charge}>loaded with {typeName(loaded, group.chargeTypeId)}</span>
      )}
    </span>
    {group.count > 1 ? <span className={styles.stack}>×{group.count}</span> : null}
  </li>
)

const typeName = (loaded: FitCalculation, typeId: number): string => loaded.eveData.types[typeId]?.name ?? `#${typeId}`

// Which module is in which slot, so a cell can draw it. The engine numbers a
// module's slot the same way ring.ts numbers a cell, which is what lets these
// two meet on a plain key.
const slotKey = (family: SlotType | string, index: number | undefined) => `${family}:${index ?? 0}`

const Ring = ({ loaded }: { loaded: FitCalculation }) => {
  const fitted = new Map(loaded.fit.modules.map((module) => [slotKey(module.slot.type, module.slot.index), module]))
  const cells = ringCells(loaded.slots)
  const hullType = loaded.eveData.types[loaded.fit.shipTypeId]
  const label = (family: SlotType, text: string) =>
    loaded.slots[family] === 0 ? null : (
      <span className={`${styles.ringLabel} ${styles[`label${family}`]}`}>
        {text} · {loaded.fit.modules.filter((module) => module.slot.type === family).length}/{loaded.slots[family]}
      </span>
    )

  return (
    <div className={styles.ringBox}>
      <div className={styles.ring}>
        <span className={styles.ringGuide} aria-hidden="true" />
        <div className={styles.hub}>
          <TypeIcon id={loaded.fit.shipTypeId} size={84} prefer="render" className={styles.hullRender} />
          <span className={`${styles.hullName} serif`}>{hullType?.name ?? `#${loaded.fit.shipTypeId}`}</span>
          <span className={styles.hullGroup}>{loaded.eveData.groups[hullType?.groupID ?? 0]?.name}</span>
        </div>
        {cells.map((cell) => {
          const module = fitted.get(slotKey(cell.family, cell.index))
          return (
            <span
              key={slotKey(cell.family, cell.index) + cell.x}
              className={`${styles.cell} ${module ? styles.filled : styles.empty} ${
                cell.family === 'Rig' || cell.family === 'SubSystem' ? styles.innerCell : ''
              }`}
              style={{ left: `${(cell.x * 100).toFixed(3)}%`, top: `${(cell.y * 100).toFixed(3)}%` }}
              title={module ? typeName(loaded, module.typeId) : `empty ${cell.family.toLowerCase()} slot`}
            >
              {module ? <TypeIcon id={module.typeId} size={24} className={styles.cellIcon} /> : null}
              {module?.charge ? <span className={styles.chargeDot} aria-hidden="true" /> : null}
            </span>
          )
        })}
        {label('High', 'high')}
        {label('Medium', 'mid')}
        {label('Low', 'low')}
        {label('Rig', 'rigs')}
      </div>
    </div>
  )
}

// "Aboard right now": one card per bay the hull has, each drawn against its own
// capacity — a full drone bay and a nearly empty freighter hold both read at a
// glance, which a shared scale would not give.
const BayPanel = ({ bays, eveData }: { bays: Bay[]; eveData: FitCalculation['eveData'] }) => {
  if (bays.length === 0) return <p className={styles.emptySection}>This hull carries nothing and has no bays.</p>

  return (
    <>
      <h2 className={styles.panelHeading}>Aboard right now</h2>
      <div className={styles.bays}>
        {bays.map((bay) => (
          <div key={bay.flag} className={`${styles.bay} ${bay.items.length === 0 ? styles.bayEmpty : ''}`}>
            <div className={styles.bayHead}>
              <span>{bay.label}</span>
              <span className={styles.bayFill}>
                {bay.used === null ? '—' : formatVolume(bay.used)}
                {bay.capacity === null ? '' : ` / ${formatVolume(bay.capacity)}`} m³
              </span>
            </div>
            {bay.capacity === null || bay.used === null ? null : (
              <span className={styles.track}>
                <span
                  className={`${styles.fill} ${barTone(bay.used, bay.capacity)}`}
                  style={{ width: barWidth(bay.used, bay.capacity) }}
                />
              </span>
            )}
            {bay.items.length === 0 ? (
              <p className={styles.emptySection}>empty</p>
            ) : (
              <ul className={styles.bayItems}>
                {bay.items.map((item) => (
                  <li key={item.typeId} className={styles.module}>
                    <TypeIcon id={item.typeId} size={20} className={styles.moduleIcon} />
                    <span className={`${styles.moduleName} serif`}>
                      {eveData.types[item.typeId]?.name ?? `#${item.typeId}`}
                    </span>
                    <span className={styles.stack}>×{formatCount(item.quantity)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

// The readout. Every figure is an attribute the engine produced — the panel
// only formats — so this is the same model eveship.fit comes up with, with the
// resist grid pulled out of the list because twelve resonances are a table.
const StatsPanel = ({
  loaded,
  pilot,
  basis,
  onBasis,
}: {
  loaded: FitCalculation
  pilot?: PilotSkills | null
  basis: Basis
  onBasis: (basis: Basis) => void
}) => (
  <>
    <h2 className={styles.panelHeading}>Statistics</h2>
    {/* The sentence that states the assumption is also where you change it.
        Without a pilot to offer (a corp hull, a shared fit, an account with no
        skills scope) it stays the plain claim it has always been. */}
    <p className={styles.baseline}>
      {pilot && basis === 'pilot'
        ? `Calculated against ${pilot.name}'s trained skills.`
        : 'Calculated against all skills at level V.'}
      {pilot ? (
        <button
          type="button"
          className={`quiet ${styles.basisToggle}`}
          onClick={() => onBasis(basis === 'pilot' ? 'all-v' : 'pilot')}
        >
          {basis === 'pilot' ? 'show all V' : `show ${pilot.name}'s skills`}
        </button>
      ) : null}
    </p>
    <div className={styles.stats}>
      <div className={`${styles.statGroup} ${styles.resistGroup}`}>
        <h3 className={styles.legend}>Resistances</h3>
        <div className={styles.resistScroll}>
          <table className={styles.resists}>
            <thead>
              <tr>
                <th />
                {DAMAGE_TYPES.map((damage) => (
                  <th key={damage} scope="col">
                    {damage}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RESIST_LAYERS.map((layer) => (
                <tr key={layer.label}>
                  <th scope="row">{layer.label}</th>
                  {DAMAGE_TYPES.map((damage) => (
                    <td key={damage}>
                      {formatAttribute(loaded.eveData, loaded.calculation, resistFormat(layer.prefix, damage))}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {STAT_GROUPS.map((group) => (
        <div key={group.label} className={styles.statGroup}>
          <h3 className={styles.legend}>{group.label}</h3>
          <dl className={styles.statRows}>
            {group.rows.map((row) => (
              <div key={row.label + row.name} className={styles.statRow}>
                <dt>{row.label}</dt>
                <dd>
                  {formatAttribute(loaded.eveData, loaded.calculation, row)}
                  {row.unit ? <span className={styles.unit}> {row.unit}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  </>
)
