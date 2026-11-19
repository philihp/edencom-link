// The `ledger` Vercel flag: every ledger page stays dark until the owner turns
// it on (docs/ledger/plan.md, the per-stage protocol). Read like
// src/app/mail/corpSpam.ts, and fails closed: a flag that cannot be read, or
// reads as anything but true, keeps the pages off.
import { flagsClient } from '@vercel/flags-core'

export const LEDGER_FLAG = 'ledger'

export const ledgerEnabled = async (): Promise<boolean> => {
  try {
    const { value } = await flagsClient.evaluate<boolean>(LEDGER_FLAG, false)
    return value === true
  } catch {
    return false
  }
}
