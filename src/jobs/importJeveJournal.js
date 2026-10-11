import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { addIndex, chain, countBy, filter, forEach, fromPairs, map, pipe, prop, splitEvery, uniqBy } from 'ramda'

import { sudoSupabase } from '../supabase.js'
import { forEachSequential } from './lib.js'

// One-off backfill: a jEveAssets profile's wallet journal → character_wallet_journal.
//
//   pnpm run import-jeve-journal -- --db <copy of profiles/#Default.db> [--xml <profile .xml>...] [--dry-run]
//
// --db is a jEveAssets 8.x SQLite profile (`journals` + `owners`); --xml is a
// 6.x/7.x UTF-16 profile export (`<esiowner id=…><journals><journal …/>`), the
// form the versioned backups and older portable installs hold. Rows from every
// source are unioned by (character, ref id). Only characters that are registered
// here are imported — an owner with no registration row is reported and skipped,
// never guessed at. Idempotent: the upsert ignores rows already present, so a
// re-run after the extract job has started adds nothing twice.
//
// Work from a COPY of the live file (jEveAssets holds it open), and never commit
// or upload the profile: its `owners` table carries live SSO refresh tokens,
// which this script does not read.

const BATCH = 500

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
// Every value following a repeated flag (`--xml a --xml b`).
const flags = (name) => addIndex(filter)((_, i) => args[i - 1] === name, args)
const dryRun = args.includes('--dry-run')

const toIso = (ms) => new Date(Number(ms)).toISOString()
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v))
const txt = (v) => (v === undefined || v === null || v === '' ? null : String(v))

// jEveAssets stores the ESI journal entry under its own column names; this is
// the one place they are translated back to ESI's.
const toRow = (registration_id, j) => ({
  registration_id,
  entry_id: Number(j.refid),
  date: toIso(j.date),
  ref_type: String(j.reftypestring),
  amount: num(j.amount),
  balance: num(j.balance),
  reason: txt(j.reason),
  description: txt(j.description),
  first_party_id: num(j.ownerid1),
  second_party_id: num(j.ownerid2),
  context_id: num(j.contextid),
  context_id_type: txt(j.contexttypestring),
  tax: num(j.taxamount),
  tax_receiver_id: num(j.taxreceiverid),
})

// → [{ characterId, name, entries: [journal attrs…] }] per owner in the DB.
const readDb = (path) => {
  const db = new DatabaseSync(path, { readOnly: true })
  const owners = db.prepare('select accountid, ownerid, name from owners').all()
  const byAccount = db.prepare(
    'select refid, date, reftypestring, amount, balance, reason, description, ownerid1, ownerid2, contextid, contexttypestring, taxamount, taxreceiverid from journals where accountid = ?'
  )
  const out = map(
    (o) => ({ characterId: Number(o.ownerid), name: o.name, entries: byAccount.all(o.accountid) }),
    owners
  )
  db.close()
  return out
}

// → the same shape from a UTF-16 profile export. jEveAssets writes these with a
// byte-order mark and Java's default (big-endian) order, so the mark decides the
// decoder rather than assuming the little-endian form Node calls 'utf16le'.
// Attribute order inside a tag is not fixed, so each tag is read as a bag of
// attributes.
const attrs = (tag) => fromPairs(map(([, k, v]) => [k, v], [...tag.matchAll(/(\w+)="([^"]*)"/g)]))
const decodeUtf16 = (buf) => new TextDecoder(buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : 'utf-16le').decode(buf)
const readXml = (path) => {
  const text = decodeUtf16(readFileSync(path))
  return map(
    (m) => {
      const owner = attrs(m[1])
      return {
        characterId: Number(owner.id),
        name: owner.name,
        entries: map((j) => attrs(j[1]), [...m[2].matchAll(/<journal ([^>]*)\/>/g)]),
      }
    },
    [...text.matchAll(/<esiowner ([^>]*)>([\s\S]*?)<\/esiowner>/g)]
  )
}

const main = async () => {
  const dbPath = flag('--db')
  const xmlPaths = flags('--xml')
  if (!dbPath && xmlPaths.length === 0) {
    console.error('usage: import-jeve-journal --db <profile.db> [--xml <profile.xml>...] [--dry-run]')
    process.exit(2)
  }
  const sources = [...(dbPath ? readDb(dbPath) : []), ...chain(readXml, xmlPaths)]

  const characterIds = [...new Set(map((s) => s.characterId, sources))]
  const { data: registrations, error } = await sudoSupabase
    .from('registration')
    .select('id, character_id, name')
    .in('character_id', characterIds)
  if (error) throw error
  const registrationOf = fromPairs(map((r) => [Number(r.character_id), r.id], registrations))

  const rows = pipe(
    filter((s) => {
      if (registrationOf[s.characterId]) return true
      console.log(`skip ${s.name} (${s.characterId}): not registered here`)
      return false
    }),
    chain((s) => map((j) => toRow(registrationOf[s.characterId], j), s.entries)),
    uniqBy((r) => `${r.registration_id}:${r.entry_id}`)
  )(sources)

  const perCharacter = countBy(prop('registration_id'), rows)
  console.log(`${rows.length} unique journal rows across ${Object.keys(perCharacter).length} characters`)
  forEach((r) => {
    if (perCharacter[r.id]) console.log(`  ${r.name}: ${perCharacter[r.id]}`)
  }, registrations)
  if (dryRun) return

  let written = 0
  await forEachSequential(splitEvery(BATCH, rows), async (batch) => {
    const { error: upsertError } = await sudoSupabase
      .from('character_wallet_journal')
      .upsert(batch, { onConflict: 'registration_id,entry_id', ignoreDuplicates: true })
    if (upsertError) throw upsertError
    written += batch.length
    if (written % 20000 < BATCH) console.log(`  ${written}/${rows.length}`)
  })
  console.log(`done: ${written} rows sent`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
