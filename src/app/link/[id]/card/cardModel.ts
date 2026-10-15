// The pure half of a Link's link-preview card: what it says the Link reads.
// No I/O, so it is unit-tested (test/linkCard.test.ts).

// "Data Link · assets": the query's one top-level field, when it parses.
export const linkSubtitle = (field: string | null): string => (field ? `Data Link · ${field}` : 'Data Link')

// The line under the title in a chat embed.
export const linkDescription = (name: string, field: string | null): string =>
  `${name}: a live Edencom Link${field ? ` over ${field}` : ''}. Open it for current results.`
