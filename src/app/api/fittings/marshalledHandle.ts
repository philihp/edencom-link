// The handle of a marshalled fit is its content hash (docs/fitting-marshal.md):
// src/fittingArchive.ts contentHash, sha256 hex. Sixty-four hex characters
// cannot be mistaken for the other two handles /api/fittings uses — a
// fitting id is digits only, a restore key is a uuid — so the shape alone says
// what a path segment names.
//
// Pure, so the rule is tested without a request. Case-insensitive on the way
// in (a hash copied from a hex dump may be upper-case), lower-cased on the way
// out, since the table's check constraint and primary key are on the
// lower-case form and `PUT` compares the body's hash with it exactly.
const HASH = /^[0-9a-f]{64}$/i

export const parseMarshalledHandle = (raw: string): string | null => (HASH.test(raw) ? raw.toLowerCase() : null)

/** The one URL a marshalled fit lives at on the site (its page lands in PR 3). */
export const marshalledRoute = (contentHash: string): string => `/fitting/marshalled/${contentHash}`
