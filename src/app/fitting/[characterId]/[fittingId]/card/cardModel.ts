// The pure half of a saved fitting's link-preview card. The card itself is
// the ship card (ship/[itemId]/card), which draws a fit slot by slot whether
// the fit sits in a hangar or in a pilot's fitting library; only the chat
// embed's line differs, since a saved fit is a plan, not a ship anyone owns.
// No I/O, so it is unit-tested (test/fittingCard.test.ts).
import { type CardRow, type CardValue, compactIsk } from '../../../../ship/[itemId]/card/cardModel.ts'

// The line under the title in a chat embed.
export const fittingDescription = (
  hullName: string,
  groupName: string | null,
  pilotName: string,
  rows: CardRow[],
  value: CardValue
): string =>
  [
    `${groupName ? `${hullName} (${groupName})` : hullName} fitting, saved by ${pilotName}.`,
    rows.length > 0
      ? `${rows.map((row) => `${row.label} ${row.icons.reduce((n, icon) => n + icon.count, 0)}`).join(' · ')}.`
      : null,
    value.sell == null ? null : `Estimated cost ${compactIsk(value.sell)}.`,
  ]
    .filter((part) => part != null)
    .join(' ')
