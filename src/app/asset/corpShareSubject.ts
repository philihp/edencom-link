import type { CorpShareDialogData, ShareDialogData } from './shareData'

// Which share a Share button is for. Pure, so the one
// decision that binds a dialog to a writer is testable: bind a corp item to the
// character writer (or the other way round) and the save is simply refused.
//
// An asset is in exactly one hangar, so the payload the page fetched is the
// answer. `corporationName` is the discriminator because only the corp payload
// carries it — fetchCorpShareDialogData() reads it for the hint, and the
// character payload has `mainName` instead (a corporation has no main to show
// as the owner).
export type AssetShareData = ShareDialogData | CorpShareDialogData

export const isCorpShare = (data: AssetShareData): data is CorpShareDialogData => 'corporationName' in data
