import { revokeCorpPlaceShare, saveCorpPlaceShare } from './corpShareActions'
import { type PlaceGrantor, placeShareHint, placeShareSubject } from './placeShare'
import { revokePlaceShare, savePlaceShare } from './shareActions'
import type { CorpShareDialogData, ShareDialogData } from './shareData'
import { ShareDialog } from './shareDialog'

// The Share button for one owner's items at a place — a station, structure or
// system (docs/sharing-layer/15-place-share.md). A place page offers one per
// owner of the caller's holding something there, since each share covers only
// its grantor's own items; this binds the dialog to that grantor's writer.
export type PlaceShare = { grantor: PlaceGrantor; data: ShareDialogData | CorpShareDialogData }

export const PlaceShareDialog = ({
  placeId,
  placeName,
  share: { grantor, data },
}: {
  placeId: string
  placeName: string
  share: PlaceShare
}) => (
  <ShareDialog
    subjectLabel="place"
    urlPath={`/asset/${placeId}`}
    data={data}
    save={
      grantor.kind === 'corporation'
        ? saveCorpPlaceShare.bind(null, grantor.corporationId, placeId)
        : savePlaceShare.bind(null, grantor.registrationId, placeId)
    }
    revoke={
      grantor.kind === 'corporation'
        ? revokeCorpPlaceShare.bind(null, grantor.corporationId, placeId)
        : revokePlaceShare.bind(null, grantor.registrationId, placeId)
    }
    hint={placeShareHint(grantor, placeName)}
    buttonLabel={placeShareSubject(grantor)}
  />
)
