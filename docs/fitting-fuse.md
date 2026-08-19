# Fittings as files: a macOS FUSE mount over the archive

EVE caps a character at **500 saved fittings**. For anyone flying more than one
doctrine that stops being a limit and becomes a budget: fits get deleted to make
room, and the deleted ones are gone. [`fitting-paging.md`](fitting-paging.md)
framed the fix as paging — the game's list is the resident set, this site is the
backing store. This is that idea shipped, with the filesystem as the interface.

The mount is the game's list. An archive is any folder on the disk. Moving a fit
between them is `cp` and `rm`:

```sh
M=~/EVE/Fittings/"Philihp Hallgren"
A=~/EVE/Archive

ls "$M"                                   # every fitting saved in game
cp "$M/Rifter - Cheap Tackle.json" "$A/"  # archive a copy
rm "$M/Rifter - Cheap Tackle.json"        # delete it in EVE, freeing a slot
cp "$A/Rifter - Cheap Tackle.json" "$M/"  # months later, put it back
df -k ~/EVE/Fittings                      # slots used and free
```

Shipped in two halves: `/api/fittings` in this app, and `fuse/` — a Go program
built against macFUSE. They are described in that order, because everything
interesting is on the server.

## Why a filesystem

Because the operations are already filesystem operations. "Keep 500 of these,
put the rest somewhere safe, bring one back later" is what `cp`, `rm` and a
backup folder have done since 1971, and every EVE player already owns the tools.
A GUI would have to reinvent copy, multi-select, undo, and a place to put
things; Finder, `rsync`, git, Time Machine and Dropbox already do those, and
work on the archive folder for free the moment the files are ordinary.

It also keeps the archive honest. Nothing here is a proprietary export: a file
is the JSON object ESI returns for a fitting, byte for byte, and this program
is not needed to read one back.

## Why it goes through edencom-link

The client holds no EVE credentials. It carries one revocable `api_token` — the
same one the Sheets CSV endpoints use — and everything else happens here:

- **The ESI grant.** Tokens, refresh, and the fact that a refresh is also how we
  learn a grant was revoked. A desktop program doing its own OAuth would need a
  token store, a refresh loop, and a browser prompt in a thing that is supposed
  to look like a folder.
- **The error budget.** CCP counts errors per application. One deployment making
  the calls is one budget to reason about, not one per laptop.
- **The rules.** The 500-slot check, the dedupe, the "is this JSON actually a
  fitting" validation, and what ESI accepts this month all live in one place
  that is deployed and monitored, rather than in a binary someone downloaded in
  March.
- **Observability.** Every write lands in `fitting_write_log` and every read is
  a request on a deployment that already has Server-Timing, metrics and logs.
  The one thing you cannot debug is the thing that happened on a laptop.

The client is left with the part only it can do: being a filesystem.

## The server: `/api/fittings`

Authenticated by `user_settings.api_token` (as `Authorization: Bearer …`, or
`?token=` to stay curl-able like the CSV endpoints). The token resolves through
a service-role client, so every query scopes itself to the caller's
registrations by hand — there is no RLS backstop on this path.

| Route                                            | What it does                                       |
| ------------------------------------------------ | -------------------------------------------------- |
| `GET /api/fittings`                              | every character and every fitting, in one response |
| `GET /api/fittings/{characterId}/{handle}`       | one archive file                                   |
| `PUT /api/fittings/{characterId}/{requestId}`    | restore an archive file into EVE                   |
| `DELETE /api/fittings/{characterId}/{fittingId}` | archive it: store it, then delete it from EVE      |

`characterId` is the EVE numeric id, matching `/fitting/[characterId]/…` rather
than the registration uuid the tables key on.

**The handle in the last segment is one of two things**, and which one says what
you are naming. A **number** is the game's own `fitting_id`, for a fit EVE
already has — that is what GET and DELETE address. A **uuid** is a key the
caller mints for a restore, because the fitting it creates does not exist yet
and CCP, not us, assigns its id. PUT addresses that one, and GET resolves it
too once the restore has run, so the URI you wrote to is a URI you can read
back.

That is why a restore is a PUT rather than a POST to the collection. The
objection to PUT is normally "the client can't name the target" — true of the
game's id, which is assigned on save and **reassigned on every restore**, so
the id in an archive file names nothing that will exist after the call. But the
key doesn't have to be the game's, or ours, or derived from the content: any
unique uuid will do, because nothing ever reads it. It names the _attempt_.

**A key is used once.** PUT to one that has already been used is a `409`, not a
replayed success — the caller has lost track of which of its writes went
through, and that is worth saying rather than papering over. Uuids are free;
mint another. Any row counts, whatever became of it: `pending` is a crashed or
in-flight attempt and `error` is a failed one, and in both cases the id has
been spent.

That is still idempotent in the sense the method promises, because idempotency
is about effects and not status codes: however many times a given PUT arrives,
the character ends up with exactly one fitting from it. A client retrying after
a lost response gets the `409`, which carries the `fitting_id` the first
attempt produced — "already done, and here is what it did" is an answer it can
act on.

The rule is enforced by a unique index, not by the read that precedes the
insert. That read is only the fast path; between it and the insert there is a
window, and two PUTs racing for one key close it on the constraint. That is
what `test/sql/fitting_write_log.sql` covers, since it is the branch no
application-level test can reach.

**The listing reads the mirror, not ESI.** Browsing is the common case by a wide
margin — one listing per Finder window, per keystroke in a save dialog — and
pointing that at CCP would spend the error budget for freshness nobody can
perceive. `character_fitting` is what `ls` sees; `data_refreshed` per character
says how old it is. Both write routes fetch live from ESI before they act, so
staleness never reaches a decision that matters.

**Writes are synchronous, not queued.** Everywhere else in this app an ESI-side
effect would be a job dispatched through the queue. Here the caller is a
filesystem: `rm` has to have actually deleted the fit by the time it returns, or
the next `ls` shows a file that no longer exists. So the route calls ESI itself
and converges the local SCD rows before answering — closing the row on a delete,
opening one on a restore, in exactly the shape `character-fittings` would have
written. The next extract then agrees rather than churning.

### The write scope is a different kind of ask

`esi-fittings.write_fittings.v1` is this app's **first write scope**. Every
other token is read-only and the site has never changed anything in game. That
line is kept visible in the mechanics:

- `EsiScope` gains an `optIn` flag, and `defaultScopes` now means "every scope
  except the opt-in ones". Every other optional scope is requested by default
  and unchecked by players who don't want it; this one is the reverse.
- A character without the scope is `writable: false` in the listing, which the
  client turns into a read-only folder — so `rm` fails at `open()` with the
  reason, not after a round trip to CCP.
- The refresh before every write re-checks that EVE still recognizes the scope,
  since a grant revoked on CCP's side leaves our stored row unchanged.

### `fitting_write_log`, and why it is written first

Deleting the wrong thing is the nightmare case, so the audit row goes in
**before** the ESI call and carries the fit's whole body — name, hull, every
module — not a reference to a row elsewhere.

A crash between the insert and CCP's `204` leaves a `pending` row holding a
complete, restorable copy of a fit that may or may not still exist. The far
worse shape — a fit deleted from the game with nothing on this side to replay —
cannot happen. `character_fitting_over_time` keeps history too, but it is a
mirror of what the extract last saw: a fit created and deleted between two
extracts never appears in it at all.

The delete path in full:

1. `GET /fittings` live. The mirror can be six hours old and the fit may have
   been edited in the client since; deleting on the strength of a stale row
   would destroy a version nobody ever stored.
2. Not there any more? Converge the local row and answer 404 — the caller asked
   for it to be gone, and it is.
3. Insert the log row, holding what ESI **currently** says the fit is.
4. `DELETE`. Close the log row `ok`, or `error` with CCP's own message.
5. Close the local SCD row so the next listing agrees.

The response carries the deleted fit, so a client that archived nothing still
ends up holding a copy.

The restore path is the same shape in reverse: refuse the request id if it has
already been used, validate the file, fetch live, return the existing
`fitting_id` if the character already has that exact fit, refuse with `507` if
all 500 slots are full, then log → `POST` to ESI → open the local row.

Two guards against saving the same fit twice, because they catch different
accidents. The **request id** is used once, so a repeated request can never
become a second fitting whatever its body says — and it is refused before CCP
is called at all. The **content hash** catches the same fit arriving under a
fresh key, which is the ordinary case: copying the same archive file in twice
mints a new uuid each time, so only the content can tell you the game already
has it. Neither subsumes the other, which is why both are there.

### Identity is content, not the game's id

`fitting_id` is assigned by the game on `POST`. Archive a fit and restore it and
it comes back with a **different one**. So the id is a frame number, never the
identity of a file. `src/fittingArchive.ts` hashes the normalized
`(ship_type_id, name, description, items)` tuple instead, which is what answers
both questions the write path has to get right: "does the character already have
this fit saved?" and "is the fit I am about to delete still the one I stored?"

The normalization is deliberately the same one `character-fittings` applies, and
sorts on plain codepoint order rather than `localeCompare` — a hash that varies
by machine locale would be a hash.

## The client: `fuse/`

Go, built against [macFUSE](https://macfuse.io) through
[cgofuse](https://github.com/winfsp/cgofuse). Install and usage are in
[`fuse/README.md`](../fuse/README.md).

```
~/EVE/Fittings/
  Philihp Hallgren/
    Hurricane - Doctrine Cane.json
    Rifter - Cheap Tackle.json
  Alt Pilot/
    …
```

One folder per linked character, one file per saved fitting, two levels deep and
no further — a fitting library has no folders in game either.

**Filenames lead with the hull**, because that is how a fitting library is
actually browsed ("what do I have for a Hurricane"), and it makes an
alphabetical listing group by ship for free. Names are sanitized to one path
component (EVE allows `/` in a fit name) and deduplicated with ` (2)` suffixes
assigned by fitting id, so the same library mounts the same way every time.
The filename is decoration: a fit's identity is the JSON inside, so restoring
works whatever the file ended up called.

**File contents are rendered client-side** from the listing rather than fetched
per file. A mount is up to 500 fits per character and the listing already
carries every field, so a directory would otherwise be 500 round trips — and it
makes the size reported by `stat` and the bytes returned by `read` the same
function, which is the failure mode that would silently truncate a file.

**A restore happens on `Flush`, not `Release`**, because `close(2)` reports what
`Flush` returns and throws away what `Release` does. A copy CCP refuses has to
fail the `cp`, not succeed quietly and leave the player believing their fit is
back in game. Written files are buffered whole in memory until then: there is no
partial fit to send, and an interrupted copy must never reach the game.

Refusals map to the errno that misleads least, with the server's sentence in the
daemon log: `507` (all 500 slots full) becomes **`ENOSPC`**, so a full character
reports "No space left on device"; `400` becomes `EINVAL`; `401`/`403` become
`EACCES`. `df -k` reports the slot budget as blocks, one block per fitting.

Everything with a rule in it — sanitizing, deduplicating, rendering, the HTTP
client — is in `internal/`, which builds and tests on any machine and is covered
by `go test`. `fs.go` only translates. The CI job builds and tests it on Linux,
which is what a runner is; the same source is what `make` produces on macOS.

## Known limits

- **`df` conflates characters.** `statfs` is per-mount, but the 500-slot cap is
  per character. The mount reports 500 × the number of characters, which is
  right in the single-character case and a rough gauge otherwise. Per-character
  truth is in the listing.
- **The write path is not queued.** Two clients archiving at once against the
  same character are two concurrent ESI writes. Each verifies live before
  acting, so the failure mode is a 404 on the loser, not a wrong delete.
- **Finder does more than `cp`.** The mount is created with `noappledouble`,
  `noapplexattr` and `nobrowse`, and `Create` refuses dotfiles outright, so
  `.DS_Store` and resource forks are never POSTed at CCP. `chmod`, `chown` and
  `utimens` are accepted and dropped so `cp -p` doesn't report a failure for a
  copy that worked.
- **Linux and Windows are untested targets.** cgofuse supports both (libfuse and
  WinFsp), and nothing in the client is macOS-specific beyond the mount options,
  but only the macOS path is a supported deliverable.
- **`fitting_write_log` grows forever.** It is small (a row per archive, per
  player) and it is the recovery story, so nothing prunes it.
