// The materialized path of where an item lives, shown as a breadcrumb at the
// top of /asset/[locationId] and /ship/[itemId]: Assets › root place ›
// enclosing containers › the page's subject. The ancestor chain comes from
// the asset_ancestors() Postgres function (one RPC for the whole climb,
// RLS-scoped to the caller); the root place is named via resolveLocations and
// containers via their custom name or SDE type name.
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { map, reverse } from 'ramda'
import { createClient } from '@/utils/supabase/server'
import { resolveLocations } from './resolveLocations'
import { fetchTypeNames } from './typeNames'
import styles from './assetPath.module.css'

export type Crumb = { href: string | null; label: string }

type AncestorRow = {
  item_id: number | string
  type_id: number | string
  name: string | null
  location_id: number | string | null
  location_type: string | null
  depth: number
}

const ASSETS_CRUMB: Crumb = { href: '/asset', label: 'Assets' }

export const fetchAssetPath = async (itemId: string, client?: SupabaseClient): Promise<Crumb[]> => {
  const supabase = client ?? (await createClient())

  // Rows come back depth-ascending: the subject itself first, then each
  // enclosing container outward. The outermost row's location_id is the root
  // place (station / structure / solar system) — or, on an RLS gap, the first
  // parent the caller can't see, which nameFor falls back to `Location #id`.
  const { data } = await supabase.rpc('asset_ancestors', { start_id: itemId })
  const rows = (data ?? []) as AncestorRow[]
  const outermost = rows[rows.length - 1]
  if (!outermost || outermost.location_id == null) return [ASSETS_CRUMB]

  // The subject renders as the page's own non-link `current` crumb; only the
  // rows above it become linked ancestors.
  const ancestors = rows.slice(1)
  const root = { id: String(outermost.location_id), type: outermost.location_type }
  const [resolved, typeNames] = await Promise.all([
    resolveLocations([root], supabase),
    fetchTypeNames(map((a: AncestorRow) => Number(a.type_id), ancestors)),
  ])

  return [
    ASSETS_CRUMB,
    { href: `/asset/${root.id}`, label: resolved.nameFor(root) },
    ...map(
      (a: AncestorRow) => ({
        href: `/asset/${a.item_id}`,
        label: a.name ?? typeNames[Number(a.type_id)] ?? `#${a.type_id}`,
      }),
      reverse(ancestors)
    ),
  ]
}

export const AssetPath = ({ crumbs, current }: { crumbs: Crumb[]; current?: string }) => (
  <nav aria-label="Breadcrumb" className={styles.path}>
    {crumbs.map((crumb, i) => (
      <span key={`${crumb.href}-${i}`}>
        {i > 0 && <span className={styles.separator}>›</span>}
        {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span>{crumb.label}</span>}
      </span>
    ))}
    {current != null && (
      <span>
        <span className={styles.separator}>›</span>
        <span className={styles.current}>{current}</span>
      </span>
    )}
  </nav>
)
