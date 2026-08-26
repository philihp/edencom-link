// Icons for the Services chips. ESI's structure services are *names*, not
// modules — one Standup Research Lab shows up as four services ("Invention",
// "Blueprint Copying", …) — so there is no type id on the row and no fitting
// endpoint to get one from. What we can do is name the Standup module that
// provides each service and let the SDE supply its type id at runtime: the
// mapping below is names only (display sugar, degrading to a bare chip when a
// name is missing or the SDE search disagrees), so no type ids are hardcoded.
import { searchSdeTypes } from '@/sdeTypes'

// service name (as ESI reports it) -> the providing Standup module's SDE name.
// The I-variant everywhere: the icon is the same artwork as the II.
export const SERVICE_MODULE_NAMES: Readonly<Record<string, string>> = {
  'Manufacturing (Standard)': 'Standup Manufacturing Plant I',
  'Manufacturing (Capitals)': 'Standup Capital Shipyard I',
  'Manufacturing (Supercapitals)': 'Standup Supercapital Shipyard I',
  'Blueprint Copying': 'Standup Research Lab I',
  'Material Efficiency Research': 'Standup Research Lab I',
  'Time Efficiency Research': 'Standup Research Lab I',
  Invention: 'Standup Invention Lab I',
  'Market Hub': 'Standup Market Hub I',
  'Clone Bay': 'Standup Cloning Center I',
  Reprocessing: 'Standup Reprocessing Facility I',
  'Composite Reactions': 'Standup Composite Reactor I',
  'Biochemical Reactions': 'Standup Biochemical Reactor I',
  'Hybrid Reactions': 'Standup Hybrid Reactor I',
  'Moon Drilling': 'Standup Moon Drill I',
}

// Per-process memo of module name -> type id (or null for "the SDE didn't
// confirm it"). Small and stable — a handful of Standup names per deploy.
const resolved = new Map<string, number | null>()

const resolveModule = async (moduleName: string): Promise<number | null> => {
  if (resolved.has(moduleName)) return resolved.get(moduleName) ?? null
  const hits = await searchSdeTypes(moduleName, 5)
  // Exact-name match only: a fuzzy hit would put a confident wrong icon on the
  // chip, which is worse than none.
  const hit = hits.find((h) => h.name.toLowerCase() === moduleName.toLowerCase())
  const typeID = hit?.typeID ?? null
  resolved.set(moduleName, typeID)
  return typeID
}

// service names -> type id where known, resolved through the SDE in one pass.
export const resolveServiceIcons = async (serviceNames: readonly string[]): Promise<Map<string, number>> => {
  const wanted = [...new Set(serviceNames.map((name) => SERVICE_MODULE_NAMES[name]).filter(Boolean))] as string[]
  await Promise.all(wanted.map(resolveModule))
  const icons = new Map<string, number>()
  for (const name of serviceNames) {
    const moduleName = SERVICE_MODULE_NAMES[name]
    const typeID = moduleName ? (resolved.get(moduleName) ?? null) : null
    if (typeID != null) icons.set(name, typeID)
  }
  return icons
}
