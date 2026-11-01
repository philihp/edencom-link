import { revokeCorpAssetShare, saveCorpAssetShare } from './corpShareActions'
import { type AssetShareData, isCorpShare } from './corpShareSubject'
import { revokeAssetShare, saveAssetShare } from './shareActions'
import { ShareDialog } from './shareDialog'
import { shareHint } from './shareHint'

// The Share button for one asset, character- or corp-owned. The dialog itself
// is generic (docs/sharing-layer/03-share-dialog.md); this is the one place
// that picks which writer it is bound to, so /asset/[locationId] and
// /ship/[itemId] both stay a single line. The choice and the hint are the pure
// corpShareSubject.ts next door; the hint is shareHint.ts, naming `path` —
// the root place down to this item (sharePath).
export type { AssetShareData }

// The line the dialog gains when the ship carries a memory
// (docs/ship-memory.md, "Display"): the text follows the share.
export const MEMORY_SHARE_NOTE = "This ship's memory is shown to everyone this reaches."

const withMemoryNote = (hint: string, hasMemory: boolean) => (hasMemory ? `${hint} ${MEMORY_SHARE_NOTE}` : hint)

export const AssetShareDialog = ({
  itemId,
  subjectLabel,
  urlPath,
  path,
  data,
  hasMemory = false,
}: {
  itemId: string
  subjectLabel: string
  urlPath: string
  path: string[]
  data: AssetShareData
  // The subject is a hull with a memory, which every reader of the share
  // reads too.
  hasMemory?: boolean
}) =>
  isCorpShare(data) ? (
    <ShareDialog
      subjectLabel={subjectLabel}
      urlPath={urlPath}
      data={data}
      save={saveCorpAssetShare.bind(null, itemId)}
      revoke={revokeCorpAssetShare.bind(null, itemId)}
      hint={withMemoryNote(shareHint(itemId, path, { kind: 'corporation', name: data.corporationName }), hasMemory)}
    />
  ) : (
    <ShareDialog
      subjectLabel={subjectLabel}
      urlPath={urlPath}
      data={data}
      save={saveAssetShare.bind(null, itemId)}
      revoke={revokeAssetShare.bind(null, itemId)}
      hint={withMemoryNote(shareHint(itemId, path, { kind: 'you' }), hasMemory)}
    />
  )
