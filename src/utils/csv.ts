// Serialize an array of flat row objects to CSV text for Google Sheets
// =IMPORTDATA(). The first row is the header (the keys of the first object, in
// the order Postgres returned them); every subsequent row is a record. Values
// that aren't primitives are JSON-stringified so nested json columns still land
// in a single cell.
const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Quote a field per RFC 4180 when it contains a comma, quote, or newline,
// doubling any embedded quotes.
const escapeField = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

export const toCsv = (rows: Record<string, unknown>[]): string => {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines = [headers, ...rows.map((row) => headers.map((h) => row[h]))]
  return lines.map((line) => line.map((cell) => escapeField(formatValue(cell))).join(',')).join('\r\n')
}
