import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { ShipFitViewDynamic } from '../../../ship/[itemId]/shipFitViewDynamic'
import { Name } from '../../../names'
import { fetchTypeNames } from '../../../typeNames'
import { publishFitting } from '../../actions'
import { toEsiFit, type FittingItem, type FittingRow } from '../../fit'
import { SlotGroups } from '../../slotGroups'
import styles from '../../fittings.module.css'

// One saved fitting, rendered in the eveship.fit wheel.
//
// The route carries the owning registration's uuid as well as the fitting id
// because ESI numbers fittings per pilot (every character has a fitting 1), so
// the id alone identifies nothing. RLS still does the access control — a uuid
// belonging to another account matches no row.
const FittingDetailPage = async ({ params }: { params: Promise<{ characterId: string; fittingId: string }> }) => {
  const { characterId, fittingId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: fit } = await supabase
    .from('character_fitting')
    .select('character_id, fitting_id, name, description, ship_type_id, items')
    .eq('character_id', characterId)
    .eq('fitting_id', fittingId)
    .maybeSingle<FittingRow>()
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []

  // One bulk SDE lookup covers the hull and every fitted type. The owning
  // registration's corp (and its alliance, via the world-readable corporation
  // row) decides which publish targets exist.
  const [typeNames, { data: registration }] = await Promise.all([
    fetchTypeNames([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))]),
    supabase
      .from('registration')
      .select('name, corporation_id')
      .eq('id', characterId)
      .maybeSingle<{ name: string; corporation_id: number | null }>(),
  ])
  const hull = typeNames[Number(fit.ship_type_id)] ?? `#${fit.ship_type_id}`

  const { data: corporation } = registration?.corporation_id
    ? await supabase
        .from('corporation')
        .select('name, alliance_id')
        .eq('corporation_id', registration.corporation_id)
        .maybeSingle<{ name: string | null; alliance_id: number | null }>()
    : { data: null }

  const publishToCorp = publishFitting.bind(null, characterId, fittingId, 'corporation')
  const publishToAlliance = publishFitting.bind(null, characterId, fittingId, 'alliance')

  return (
    <>
      <p className={styles.meta}>
        <Link href="/fitting">fittings</Link> / <Name name={hull} />
      </p>
      <h1 className="serif">{fit.name || `Fitting #${fit.fitting_id}`}</h1>
      <p className={styles.meta}>
        <Name name={hull} /> — saved by <Name name={registration?.name ?? null} />
      </p>
      {fit.description ? <p className={styles.description}>{fit.description}</p> : null}

      {registration?.corporation_id != null ? (
        // Publishing copies this fit into the site's corp/alliance doctrine
        // list (shared_fitting) — a snapshot, not a live link; the in-game
        // fitting folders aren't touched (ESI has no write path we use).
        <div className={styles.publishRow}>
          <form action={publishToCorp}>
            <button type="submit" className={styles.publishButton}>
              Publish to corp{corporation?.name ? ` (${corporation.name})` : ''}
            </button>
          </form>
          {corporation?.alliance_id != null ? (
            <form action={publishToAlliance}>
              <button type="submit" className={styles.publishButton}>
                Publish to alliance
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      <ShipFitViewDynamic esiFit={toEsiFit(fit)} />

      <SlotGroups items={items} typeNames={typeNames} />
    </>
  )
}

export default FittingDetailPage
