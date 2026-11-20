// The planner's settings and their pure rules: the defaults, how a stored row
// is read, and how the settings form is checked. No I/O, so
// test/plannerSettings.test.ts runs it under the node test runner.
import { find, has, reduce } from 'ramda'

// The markets the hourly price capture covers (TRACKED_MARKETS in
// src/gnfMarket.js). Jita is always the second market, so the home market is
// one of the others.
export const HOME_MARKETS = ['C-J6MT'] as const

// Rates are fractions (0.5 = 50%). Haul costs are ISK per packaged m3.
export type PlannerSettings = {
  overbuild: number
  minimumMargin: number
  marketFees: number
  sccTax: number
  homeMarket: string
  haulImport: number
  haulExport: number
}

// The values a new account starts with, and what a read gives when no row
// exists. The same numbers are the column defaults in schema.sql.
export const DEFAULT_SETTINGS: PlannerSettings = {
  overbuild: 0.5,
  minimumMargin: 0.05,
  marketFees: 0.05,
  sccTax: 0.04,
  homeMarket: 'C-J6MT',
  haulImport: 900,
  haulExport: 900,
}

export type SettingsRow = {
  overbuild: number | string
  minimum_margin: number | string
  market_fees: number | string
  scc_tax: number | string
  home_market: string
  haul_import: number | string
  haul_export: number | string
}

// A stored row as settings. PostgREST sends numeric columns as strings.
export const fromRow = (row: SettingsRow | null | undefined): PlannerSettings =>
  row
    ? {
        overbuild: Number(row.overbuild),
        minimumMargin: Number(row.minimum_margin),
        marketFees: Number(row.market_fees),
        sccTax: Number(row.scc_tax),
        homeMarket: row.home_market,
        haulImport: Number(row.haul_import),
        haulExport: Number(row.haul_export),
      }
    : DEFAULT_SETTINGS

export const toRow = (s: PlannerSettings): SettingsRow => ({
  overbuild: s.overbuild,
  minimum_margin: s.minimumMargin,
  market_fees: s.marketFees,
  scc_tax: s.sccTax,
  home_market: s.homeMarket,
  haul_import: s.haulImport,
  haul_export: s.haulExport,
})

// One number field of the form: its name, its label, the unit it is typed in,
// and the range the database accepts (in that unit).
type NumberField = {
  key: Exclude<keyof PlannerSettings, 'homeMarket'>
  label: string
  unit: 'percent' | 'isk'
  min: number
  max: number
}

export const NUMBER_FIELDS: readonly NumberField[] = [
  { key: 'overbuild', label: 'Component overbuild', unit: 'percent', min: 0, max: 1000 },
  { key: 'minimumMargin', label: 'Minimum margin', unit: 'percent', min: -100, max: 1000 },
  { key: 'marketFees', label: 'Market fees', unit: 'percent', min: 0, max: 100 },
  { key: 'sccTax', label: 'SCC industry tax', unit: 'percent', min: 0, max: 100 },
  { key: 'haulImport', label: 'Import haul from Jita', unit: 'isk', min: 0, max: 1e9 },
  { key: 'haulExport', label: 'Export haul to Jita', unit: 'isk', min: 0, max: 1e9 },
]

// A percent as the form shows it: 0.05 → 5, without float noise.
export const toPercent = (rate: number): number => Number((rate * 100).toFixed(4))

// One typed field read into its stored value, or an error text. A blank,
// non-numeric or out-of-range value is refused, never clamped: a saved value
// that differs from the one on screen is a silent change.
const readField = (field: NumberField, raw: unknown): number | string => {
  const text = `${raw ?? ''}`.trim()
  if (text === '') return `Enter a value for ${field.label.toLowerCase()}.`
  const n = Number(text)
  if (!Number.isFinite(n)) return `${field.label} must be a number.`
  if (n < field.min || n > field.max) return `${field.label} must be between ${field.min} and ${field.max}.`
  return field.unit === 'percent' ? n / 100 : n
}

export type FormResult = { settings: PlannerSettings } | { error: string }

// The whole form, as a map of field name to typed text, read into settings.
// The first bad field stops the read and names itself.
export const parseSettingsForm = (form: Readonly<Record<string, unknown>>): FormResult => {
  const home = `${form.homeMarket ?? ''}`
  if (!(HOME_MARKETS as readonly string[]).includes(home)) return { error: 'Choose a home market from the list.' }
  return reduce(
    (acc: FormResult, field: NumberField) => {
      if (has('error', acc)) return acc
      const value = readField(field, form[field.key])
      return typeof value === 'string' ? { error: value } : { settings: { ...acc.settings, [field.key]: value } }
    },
    { settings: { ...DEFAULT_SETTINGS, homeMarket: home } },
    NUMBER_FIELDS
  )
}

// The sheet's ManualBuildBuy choice. Anything else (the sheet had "Buid") is
// refused.
export const BUILD_BUY = ['build', 'buy'] as const
export type BuildBuy = (typeof BUILD_BUY)[number]

export const parseBuildBuy = (raw: unknown): BuildBuy | null =>
  find((c: BuildBuy) => c === `${raw ?? ''}`.trim().toLowerCase(), BUILD_BUY) ?? null

// The facility tax the plan assumes in a structure: the "own" rate where one
// of the account's corporations owns it, else the public rate (both from
// /settings/tax). An owner we do not know counts as somebody else's.
export const facilityTaxRate = (
  ownerCorporationId: number | null,
  ownCorporationIds: ReadonlySet<number>,
  rates: { own: number; public: number }
): number => (ownerCorporationId !== null && ownCorporationIds.has(ownerCorporationId) ? rates.own : rates.public)
