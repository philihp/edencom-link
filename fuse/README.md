# eve-fittings-fs

Mount an EVE character's saved ship fittings as a folder on macOS, so archiving
one is `cp` and freeing its in-game slot is `rm`.

Design notes and the server side live in [`docs/fitting-fuse.md`](../docs/fitting-fuse.md).

## Install

```sh
brew install --cask macfuse   # once; a reboot may be needed the first time
make && make install          # → /usr/local/bin/eve-fittings-fs
```

macFUSE is a kernel extension, so the first install asks for approval in System
Settings → Privacy & Security and then a restart. Everything after that is a
plain user-space program.

## Mount

Get an API token from **/account/settings** on your edencom-link deployment,
and grant **Save and delete fittings** under **ESI Access** for the characters
you want to archive from (then re-add those characters, since a token's scopes
are fixed when it is issued). Reading works without it.

```sh
export EDENCOM_TOKEN=…              # from /account/settings
mkdir -p ~/EVE/Fittings
eve-fittings-fs ~/EVE/Fittings
```

Ctrl-C unmounts. `-readonly` refuses every write regardless of what the EVE
grant allows; `-url` points at a deployment other than `https://edencom.link`;
`-ttl` sets how long a directory listing is reused (default 30s); `-debug` logs
every FUSE call.

## Use

```sh
M=~/EVE/Fittings/"Philihp Hallgren"
A=~/EVE/Archive

ls "$M"                                   # every fitting saved in game
cp "$M/Rifter - Cheap Tackle.json" "$A/"  # archive a copy
rm "$M/Rifter - Cheap Tackle.json"        # delete it in EVE, freeing a slot
cp "$A/Rifter - Cheap Tackle.json" "$M/"  # months later, put it back
df -k ~/EVE/Fittings                      # slots used and free
```

The archive is an ordinary folder — back it up, put it in git, sync it, grep
it. Each file is exactly the JSON object ESI returns for a fitting, so anything
that speaks ESI fittings can read one, and this program is not needed to get a
fit back out of the archive.

Restoring is idempotent: copying in a fit the character already has saved costs
no slot and changes nothing. Copying in a file that is not a fitting fails the
`cp` rather than reaching CCP.

## What it will not do

- **Edit a fit in place.** Fits are edited in the game client. Opening a file
  for writing gets `EACCES`; copy it out, `rm` it, copy a new one in.
- **Rename, move, or make folders.** The structure is EVE's: characters are
  folders because EVE has characters, and a fitting library has no folders.
- **Touch a character that hasn't granted the write scope.** Their folder is
  read-only, so `rm` fails before anything is asked of CCP.

## Layout

| Path             | What it is                                                               |
| ---------------- | ------------------------------------------------------------------------ |
| `main.go`        | flags, the pre-mount connection check, mount options per platform        |
| `fs.go`          | the FUSE binding: kernel calls in, API calls out, plus the listing cache |
| `internal/vfs/`  | names, uniqueness, and the exact bytes of a file — pure, and tested      |
| `internal/link/` | the HTTP client for `/api/fittings` — tested against `httptest`          |

The split is deliberate: everything with a rule in it is in `internal/`, which
builds and tests on any machine. `fs.go` only translates, and is the one part
that needs a kernel to exercise.
