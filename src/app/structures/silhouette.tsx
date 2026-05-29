/*
 * Schematic line-art silhouettes for Upwell structures, grouped by family:
 *   - Citadels (Astrahus / Fortizar / Keepstar) — tall spindle
 *   - Engineering Complexes (Raitaru / Azbel / Sotiyo) — angular wedge
 *   - Refineries (Athanor / Tatara) — ringed core
 * These are stylized outlines, not exact models — enough to tell families apart.
 */

const CITADELS = new Set([35832, 35833, 35834])
const ENGINEERING = new Set([35825, 35826, 35827])
const REFINERIES = new Set([35835, 35836])

type Family = 'citadel' | 'engineering' | 'refinery'

const familyFor = (typeId: number): Family => {
  if (ENGINEERING.has(typeId)) return 'engineering'
  if (REFINERIES.has(typeId)) return 'refinery'
  return 'citadel'
}

const PATHS: Record<Family, React.ReactNode> = {
  // Vertical spindle with a collar — the citadel look (Fortizar).
  citadel: (
    <>
      <path d="M50 6 L64 34 L60 70 L50 94 L40 70 L36 34 Z" />
      <path d="M36 40 L20 48 M64 40 L80 48" />
      <path d="M40 58 L60 58" />
      <path d="M50 6 L50 94" />
    </>
  ),
  // Compact angular wedge with side arms — the engineering complex (Raitaru).
  engineering: (
    <>
      <path d="M50 10 L78 64 L60 80 L50 66 L40 80 L22 64 Z" />
      <path d="M50 10 L50 66" />
      <path d="M34 52 L66 52" />
    </>
  ),
  // A reprocessing ring around a central core — the refinery (Tatara).
  refinery: (
    <>
      <circle cx="50" cy="54" r="28" />
      <path d="M50 14 L50 90" />
      <path d="M40 38 L60 38 L56 70 L44 70 Z" />
    </>
  ),
}

type Props = {
  typeId: number | string
  className?: string
}

export const StructureSilhouette = ({ typeId, className }: Props) => (
  <svg
    className={className}
    viewBox="0 0 100 100"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinejoin="round"
    strokeLinecap="round"
    aria-hidden="true"
    preserveAspectRatio="xMidYMid meet"
  >
    {PATHS[familyFor(Number(typeId))]}
  </svg>
)
