import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { ShipFitViewDynamic } from '../../../ship/[itemId]/shipFitViewDynamic'
import { Name } from '../../../names'
import { fetchTypeNames } from '../../../typeNames'
import type { ShareRow } from '../../actions'
import { toEsiFit, type FittingItem, type FittingRow } from '../../fit'
import { resolveFittingOwner } from '../../resolveCharacter'
import { ShareControls } from '../../shareControls'
import { SlotGroups } from '../../slotGroups'
import styles from '../../fittings.module.css'

// One saved fitting, rendered in the eveship.fit wheel.
//
// The route carries the owner's EVE character id as well as the fitting id
// because ESI numbers fittings per pilot (every character has a fitting 1), so
// the id alone identifies nothing. The tables key on the owner's registration
// uuid instead, so the character id is translated to one here
// (resolveCharacter.ts) before anything is read.
//
// RLS still does the access control: a registration belonging to another
// account matches no fitting row, *unless* a character_fitting_share row
// widens it to the caller (see schema.sql's "Audience reads shared fittings"
// policy — corp/alliance shares to current mates, public shares to any
// signed-in user), which is why the query below can return a fit for someone
// other than its owner. There is no anonymous view: every visitor signs in,
// and a non-owner gets the read-only rendering.
const FittingDetailPage = async ({ params }: { params: Promise<{ characterId: string; fittingId: string }> }) => {
  const { characterId, fittingId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const owner = await resolveFittingOwner(supabase, characterId)
  if (!owner) notFound()

  const { data: fit } = await supabase
    .from('character_fitting')
    .select('registration_id, fitting_id, name, description, ship_type_id, items')
    .eq('registration_id', owner.registrationId)
    .eq('fitting_id', fittingId)
    .maybeSingle<FittingRow>()
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []
  const typeNames = await fetchTypeNames([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))])
  const hull = typeNames[Number(fit.ship_type_id)] ?? `#${fit.ship_type_id}`

  // resolveFittingOwner set this from `registration`, which RLS scopes to the
  // caller's own rows — so it's an RLS-native ownership proof, not a guess.
  const isOwner = owner.isOwn

  let shares: ShareRow[] = []
  if (isOwner) {
    const { data } = await supabase
      .from('character_fitting_share')
      .select('id, level')
      .eq('registration_id', owner.registrationId)
      .eq('fitting_id', fittingId)
      .returns<ShareRow[]>()
    shares = data ?? []
  }

  return (
    <div className={isOwner ? undefined : styles.sharedPage}>
      {isOwner ? null : (
        <div className={styles.sharedFrom}>
          <img
            className={styles.sharedFromAvatar}
            src={`https://images.evetech.net/characters/${owner.characterId}/portrait?size=64`}
            alt=""
          />
          <span className={styles.sharedFromLabel}>
            Shared by <Name name={owner.name} />
          </span>
        </div>
      )}

      <p className={styles.meta}>
        <Link href="/fitting">fittings</Link> / <Name name={hull} />
      </p>
      <h1 className="serif">{fit.name || `Fitting #${fit.fitting_id}`}</h1>
      {isOwner ? (
        <p className={styles.meta}>
          <Name name={hull} /> — saved by <Name name={owner.name} />
        </p>
      ) : (
        <p className={styles.meta}>
          <Name name={hull} />
        </p>
      )}
      {fit.description ? <p className={styles.description}>{fit.description}</p> : null}

      {isOwner ? (
        <ShareControls registrationId={owner.registrationId} fittingId={fittingId} initialShares={shares} />
      ) : null}

      <ShipFitViewDynamic esiFit={toEsiFit(fit)} />

      <SlotGroups items={items} typeNames={typeNames} />
    </div>
  )
}

export default FittingDetailPage
