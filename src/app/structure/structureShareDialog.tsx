'use client'

import { ShareDialog } from '../asset/shareDialog'
import { revokeStructureShare, saveStructureShare } from './shareActions'
import type { StructureShareDialogData } from './shareData'

// The Share button on /structure/[structureId], for a director of the owning
// corporation (docs/sharing-layer/12-structure-share.md, "UI"). The generic
// dialog, bound to the structure writers, plus the one audience this subject
// adds: the people who build here.
export const StructureShareDialog = ({
  structureId,
  structureName,
  data,
}: {
  structureId: string
  structureName: string
  data: StructureShareDialogData
}) => (
  <ShareDialog
    subjectLabel="structure"
    urlPath={`/structure/${structureId}`}
    data={data}
    save={saveStructureShare.bind(null, structureId)}
    revoke={revokeStructureShare.bind(null, structureId)}
    hint={`Share ${structureName}, owned by ${data.corporationName}: its details, services and rigs — never fuel, revenue or jobs.`}
    extraAudience={{
      label: 'People with jobs here',
      description: 'Anyone who has run an industry job at this structure in the last 30 days',
    }}
  />
)
