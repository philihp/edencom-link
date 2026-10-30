import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { addIndex, chain, filter, forEach, fromPairs, map, splitEvery } from 'ramda'

import { sudoSupabase } from '../supabase.js'
import { decodeUtf16, parseXml, summarize, toRows } from './jeveTransactions.js'
import { forEachSequential } from './lib.js'

// One-off backfill: a jEveAssets profile's wallet transactions →
// character_wallet_transaction. The twin of importJeveJournal.js.
//
//   pnpm run import-jeve-transactions -- --db <copy of profiles/#Default.db> [--xml <profile .xml>...] [--dry-run]
//
// --db is a jEveAssets 8.x SQLite profile (`transactions` + `owners`); --xml is
// a 6.x/7.x UTF-16 profile export (`<esiowner id=…><wallettransactions>
// <wallettransaction …/>`). Rows from every source are unioned by transaction
// id. Only characters with exactly one registration here are imported; any
// other owner (not registered, registered twice, or a corporation) is reported
// and skipped, never guessed at. Idempotent: the upsert ignores transaction ids
// already present, so the rows the extract job wrote stay as they are.
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

// → [{ characterId, name, transactions: [row…] }] per owner in the DB.
const readDb = (path) => {
  const db = new DatabaseSync(path, { readOnly: true })
  const owners = db.prepare('select accountid, ownerid, name from owners').all()
  const byAccount = db.prepare(
    'select transactionid, transactiondatetime, typeid, quantity, price, transactiontype, transactionfor, clientid, stationid, journaltransactionid from transactions where accountid = ?'
  )
  const out = map(
    (o) => ({ characterId: Number(o.ownerid), name: o.name, transactions: byAccount.all(o.accountid) }),
    owners
  )
  db.close()
  return out
}

const readXml = (path) => parseXml(decodeUtf16(readFileSync(path)))

const main = async () => {
  const dbPath = flag('--db')
  const xmlPaths = flags('--xml')
  if (!dbPath && xmlPaths.length === 0) {
    console.error('usage: import-jeve-transactions --db <profile.db> [--xml <profile.xml>...] [--dry-run]')
    process.exit(2)
  }
  const sources = [...(dbPath ? readDb(dbPath) : []), ...chain(readXml, xmlPaths)]

  const characterIds = [...new Set(map((s) => s.characterId, sources))]
  const { data: registrations, error } = await sudoSupabase
    .from('registration')
    .select('id, character_id, name')
    .in('character_id', characterIds)
  if (error) throw error

  const { rows, skipped } = toRows(sources, registrations)
  forEach((s) => console.log(`skip ${s.name} (${s.characterId}): ${s.reason}`), skipped)

  const nameOf = fromPairs(map((r) => [r.id, r.name], registrations))
  console.log(`${rows.length} unique transactions`)
  forEach(
    ([id, s]) => console.log(`  ${nameOf[id]}: ${s.count} (${s.sells} sells), ${s.first} → ${s.last}`),
    summarize(rows)
  )
  if (dryRun) return

  let written = 0
  await forEachSequential(splitEvery(BATCH, rows), async (batch) => {
    const { error: upsertError } = await sudoSupabase
      .from('character_wallet_transaction')
      .upsert(batch, { onConflict: 'transaction_id', ignoreDuplicates: true })
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
