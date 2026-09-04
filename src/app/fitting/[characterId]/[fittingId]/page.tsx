import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../../account/lib/establishedUser'
import { createServiceClient } from '@/utils/supabase/service'
import { ShipFitViewDynamic } from '../../../item/[itemId]/shipFitViewDynamic'
import { Name } from '../../../names'
import { getSdeTypes } from '@/sdeTypes'
import { ShareDialog } from '../../../asset/shareDialog'
import { ShareUrlCleanup } from '../../../shareUrlCleanup'
import { verifySignedFittingShare } from '../../access'
import { saveFittingShare, revokeFittingShare } from '../../actions'
import { EftExport } from '../../eftExport'
import { toEft, type EftType } from '../../eft'
import { toEsiFit, type FittingItem, type FittingRow } from '../../fit'
import { resolveFittingOwner } from '../../resolveCharacter'
import { fetchFittingShareDialogData } from '../../shareData'
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
// widens it to the caller (schema.sql's "Audience reads shared fittings"
// policy — pinned corp/alliance audiences to current mates, a public share to
// any signed-in user). A signed ?share= link is the one path that works
// without any of that — including signed out: it verifies against the share
// row's secret + TOKEN_SALT and then reads the exact subject fit through the
// service role.
const FittingDetailPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ characterId: string; fittingId: string }>
  searchParams: Promise<{ share?: string }>
}) => {
  const { characterId, fittingId } = await params
  const { share } = await searchParams

  const supabase = await createClient()
  const user = await establishedUser(supabase)
  // Anonymous visitors may still open a signed share link; anyone else signs in.
  if (!user && !share) redirect('/')

  // Resolves for anon too: character_directory is world-readable.
  const owner = await resolveFittingOwner(supabase, characterId)
  if (!owner) notFound()

  let { data: fit } = await supabase
    .from('character_fitting')
    .select('registration_id, fitting_id, name, description, ship_type_id, items')
    .eq('registration_id', owner.registrationId)
    .eq('fitting_id', fittingId)
    .maybeSingle<FittingRow>()

  // Not RLS-visible (signed out, or no membership share aims at this caller):
  // a valid signed link still opens exactly this fit, via the service role
  // explicitly scoped to the share's subject.
  if (!fit && share && (await verifySignedFittingShare(share, owner.registrationId, fittingId))) {
    const service = createServiceClient()
    const { data: linkedFit } = await service
      .from('character_fitting')
      .select('registration_id, fitting_id, name, description, ship_type_id, items')
      .eq('registration_id', owner.registrationId)
      .eq('fitting_id', fittingId)
      .maybeSingle<FittingRow>()
    fit = linkedFit
  }
  if (!fit) notFound()

  const items: FittingItem[] = fit.items ?? []
  // Categories ride along with the names because the EFT export needs them:
  // a charge shares its module's slot flag in an ESI fitting, and only the
  // category tells the two apart (src/app/fitting/eft.ts).
  const sdeTypes = await getSdeTypes([Number(fit.ship_type_id), ...items.map((i) => Number(i.type_id))])
  const entries = Object.values(sdeTypes)
  const types: Record<number, EftType> = Object.fromEntries(
    entries.map((t) => [t.typeID, { name: t.name, categoryID: t.categoryID }])
  )
  const typeNames: Record<number, string> = Object.fromEntries(entries.map((t) => [t.typeID, t.name]))
  const hull = typeNames[Number(fit.ship_type_id)] ?? `#${fit.ship_type_id}`

  // resolveFittingOwner set this from `registration`, which RLS scopes to the
  // caller's own rows — so it's an RLS-native ownership proof, not a guess.
  const isOwner = owner.isOwn

  const shareData = isOwner ? await fetchFittingShareDialogData(supabase, owner.registrationId, fittingId) : null

  return (
    <div className={isOwner ? undefined : styles.sharedPage}>
      {share && <ShareUrlCleanup />}
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

      {shareData ? (
        <div className={styles.shareRow}>
          <ShareDialog
            subjectLabel="fitting"
            urlPath={`/fitting/${characterId}/${fittingId}`}
            data={shareData}
            save={saveFittingShare.bind(null, owner.registrationId, fittingId)}
            revoke={revokeFittingShare.bind(null, owner.registrationId, fittingId)}
          />
        </div>
      ) : null}

      <ShipFitViewDynamic esiFit={toEsiFit(fit)} />

      <SlotGroups items={items} typeNames={typeNames} />

      <EftExport eft={toEft(fit, types)} />
    </div>
  )
}

export default FittingDetailPage
