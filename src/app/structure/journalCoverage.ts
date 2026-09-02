// Which structures on the page have their facility tax billed by a wallet
// journal we can actually read.
//
// This is the distinction the Taxes Paid measures turn on, and getting it wrong
// hid real ISK. `foldEiv` suppresses the recovered estimate wherever the journal
// bills the charge exactly, because estimating on top of an exact row would
// count one charge twice. The question is therefore "can we read that
// structure's owner's journal", and the answer used to be taken from
// *ownership*: any structure owned by a corporation this account has a
// character in counted as covered.
//
// Those are different facts. Membership in a corporation says nothing about
// holding the accountant or director roles its wallet endpoints require, and on
// a shared corp — the common case for a member who is not an officer —
// corp-wallet-journal fails every run and the corp has no journal rows at all.
// There the journal is not merely inexact, it is empty, so suppressing the
// estimate left the tax invisible under both measures at once: no exact row to
// show, and no estimate allowed to stand in for it.
//
// Coverage is therefore keyed on journal rows actually existing for the owning
// corporation. The caller establishes that set (one existence probe per
// candidate corporation; see page.tsx) — this module is only the mapping from
// it to structures, kept pure so the rule itself is testable.
export type JournalCoverageInput = {
  // Every structure with a tile on the page.
  onPage: Iterable<string>
  // structure id -> the EVE corporation id that owns it, as text. A structure
  // whose owner we could not resolve is absent, and is never covered: an
  // unknown landlord is exactly the case the estimate exists for.
  structureOwner: ReadonlyMap<string, string>
  // The corporations we hold journal rows for. Not "our corporations".
  journalCoveredCorps: ReadonlySet<string>
}

export const journalCoveredStructures = ({
  onPage,
  structureOwner,
  journalCoveredCorps,
}: JournalCoverageInput): Set<string> => {
  const covered = new Set<string>()
  for (const structureId of onPage) {
    const owner = structureOwner.get(structureId)
    if (owner != null && journalCoveredCorps.has(owner)) covered.add(structureId)
  }
  return covered
}
