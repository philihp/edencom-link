import { revokeCorpAssetShare, saveCorpAssetShare } from './corpShareActions'
import { type AssetShareData, corpShareHint, isCorpShare } from './corpShareSubject'
import { revokeAssetShare, saveAssetShare } from './shareActions'
import { ShareDialog } from './shareDialog'

// The Share button for one asset, character- or corp-owned. The dialog itself
// is generic (docs/sharing-layer/03-share-dialog.md); this is the one place
// that picks which writer it is bound to, so /asset/[locationId] and
// /ship/[itemId] both stay a single line. The choice and the hint are the pure
// corpShareSubject.ts next door.
export type { AssetShareData }

export const AssetShareDialog = ({
  itemId,
  subjectLabel,
  urlPath,
  data,
}: {
  itemId: string
  subjectLabel: string
  urlPath: string
  data: AssetShareData
}) =>
  isCorpShare(data) ? (
    <ShareDialog
      subjectLabel={subjectLabel}
      urlPath={urlPath}
      data={data}
      save={saveCorpAssetShare.bind(null, itemId)}
      revoke={revokeCorpAssetShare.bind(null, itemId)}
      hint={corpShareHint(subjectLabel, data.corporationName)}
    />
  ) : (
    <ShareDialog
      subjectLabel={subjectLabel}
      urlPath={urlPath}
      data={data}
      save={saveAssetShare.bind(null, itemId)}
      revoke={revokeAssetShare.bind(null, itemId)}
    />
  )
