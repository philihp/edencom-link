// The outcome of a transfer, reduced from its two step results
// (docs/fitting-marshal.md). Pure, so the one branch that matters — the fit
// saved on the target but EVE refusing the delete on the source — has a test
// without ESI.
//
// The order of the steps is the design: the copy is made before the original
// is removed, so no failure loses the fit. That leaves three shapes:
//
//   * the restore was refused → nothing happened; report it;
//   * the restore went through and so did the delete → done, go to the new fit;
//   * the restore went through and the delete did not → the fit is on BOTH
//     characters. Safe and retryable, so it is reported, with the new fit as
//     the place to go and the original as the thing to press Marshal on.
import type { Failure, TransferSteps } from './lib'

type Pilot = { character_id: string; name: string | null }

export type TransferOutcome =
  | { ok: true; characterId: string; fittingId: number; created: boolean; message: string }
  | {
      ok: false
      stage: 'restore' | 'archive'
      status: number
      message: string
      // Set when the fit was saved on the target before the failure.
      savedCharacterId?: string
      savedFittingId?: number
    }

const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && 'status' in value && 'error' in value

const pilotName = (p: Pilot) => p.name ?? p.character_id

export const transferOutcome = (steps: TransferSteps | Failure, from: Pilot, to: Pilot): TransferOutcome => {
  // A refusal before either step ran (same character twice, no write scope,
  // the fit already gone) reads as a failed restore: nothing moved.
  if (isFailure(steps)) return { ok: false, stage: 'restore', status: steps.status, message: steps.error }
  if (isFailure(steps.restored)) {
    return { ok: false, stage: 'restore', status: steps.restored.status, message: steps.restored.error }
  }

  const { fitting_id: fittingId, created } = steps.restored
  if (steps.archived === undefined || isFailure(steps.archived)) {
    const why = steps.archived === undefined ? 'the delete was never attempted' : steps.archived.error
    return {
      ok: false,
      stage: 'archive',
      status: steps.archived === undefined ? 500 : steps.archived.status,
      message: `Saved on ${pilotName(to)} as fitting ${fittingId}, but EVE would not delete it from ${pilotName(from)}: ${why}. It is on both characters; press Marshal on the original to finish.`,
      savedCharacterId: to.character_id,
      savedFittingId: fittingId,
    }
  }

  return {
    ok: true,
    characterId: to.character_id,
    fittingId,
    created,
    message: created
      ? `Moved to ${pilotName(to)}.`
      : `${pilotName(to)} already had this fit saved; removed it from ${pilotName(from)}.`,
  }
}
