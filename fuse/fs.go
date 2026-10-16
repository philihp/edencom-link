package main

import (
	"context"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/winfsp/cgofuse/fuse"

	"github.com/philihp/edencom-link/fuse/internal/link"
	"github.com/philihp/edencom-link/fuse/internal/vfs"
)

// The filesystem itself: the thin layer that turns kernel calls into API calls.
//
// Four operations carry the whole feature, and each is the obvious thing:
//
//	ls mnt/Pilot/                        the character's saved fittings
//	cp mnt/Pilot/Rifter\ -\ Tackle.json ~/eve-fits/    archive a copy
//	rm mnt/Pilot/Rifter\ -\ Tackle.json               free the in-game slot
//	cp ~/eve-fits/Rifter\ -\ Tackle.json mnt/Pilot/   put it back, later
//	mv mnt/Pilot/Rifter\ -\ Tackle.json mnt/Marshalled/  marshal: out of the game, kept on the server
//	mv mnt/Marshalled/Rifter\ -\ Tackle.json mnt/Pilot/  unmarshal: back into the game
//	mv mnt/Pilot/Rifter\ -\ Tackle.json mnt/Alt/         transfer: saved there, then deleted here
//
// That is the entire point of mounting this rather than shipping a GUI: the
// tools for keeping 500 of something, backing them up, and putting one back
// have existed on every Unix since 1971, and a player already knows them.
type edencomFS struct {
	fuse.FileSystemBase

	client   *link.Client
	readOnly bool
	uid      uint32
	gid      uint32
	mounted  time.Time

	mu       sync.Mutex
	tree     *vfs.Tree
	fetched  time.Time
	ttl      time.Duration
	handles  map[uint64]*handle
	nextFH   uint64
	pending  []pending
	requests context.Context
}

// A file being written into a character's folder: a restore in progress.
//
// It is held entirely in memory until close, because a restore is one POST of
// one whole document — there is no partial fit to send, and a fit that arrives
// half-written (an interrupted copy) must never reach the game. An archive file
// is a couple of kilobytes, so buffering costs nothing.
type handle struct {
	dir      *vfs.Dir
	name     string
	writing  bool
	buf      []byte
	finished bool
	// The snapshot of the file's bytes, for reads. Nil for a write handle.
	content []byte
}

// A file that has just been restored but is not yet in a refreshed listing.
//
// The name a player copies in is whatever their archive file was called, while
// the name the mount gives that fit is derived from the hull and the fit's own
// name. Between the POST and the next listing those two differ, and a `cp` that
// stats what it just wrote would get ENOENT. So the written name is kept alive
// briefly, pointing at the fit that now exists.
type pending struct {
	// The folder's key: the character id, or MarshalledDirName for the archive.
	characterID string
	name        string
	content     []byte
	created     time.Time
}

const pendingGrace = 30 * time.Second

func newFS(client *link.Client, ttl time.Duration, readOnly bool) *edencomFS {
	return &edencomFS{
		client:   client,
		readOnly: readOnly,
		uid:      uint32(os.Getuid()),
		gid:      uint32(os.Getgid()),
		mounted:  time.Now(),
		ttl:      ttl,
		handles:  map[uint64]*handle{},
		nextFH:   1,
		requests: context.Background(),
	}
}

// ── the listing cache ────────────────────────────────────────────────────
//
// A directory listing is one API call, and a file browser asks for one on every
// window, every keystroke in a save dialog, and every mouse-over. Caching it for
// a few seconds is the difference between a mount that feels like a folder and
// one that feels like a website. Writes invalidate it immediately, so the thing
// a player just deleted is gone from the next `ls` regardless of the TTL.

func (fs *edencomFS) snapshot() (*vfs.Tree, error) {
	fs.mu.Lock()
	if fs.tree != nil && time.Since(fs.fetched) < fs.ttl {
		tree := fs.tree
		fs.mu.Unlock()
		return tree, nil
	}
	fs.mu.Unlock()

	characters, marshalled, err := fs.client.List(fs.requests)
	if err != nil {
		fs.mu.Lock()
		stale := fs.tree
		fs.mu.Unlock()
		// A network blip should not empty someone's mount. Serving the last
		// good listing keeps browsing working offline; only a mount that never
		// managed a first listing fails outright.
		if stale != nil {
			log.Printf("listing failed, serving the last one: %v", err)
			return stale, nil
		}
		return nil, err
	}

	tree := vfs.BuildTree(characters, marshalled)
	fs.mu.Lock()
	fs.tree = tree
	fs.fetched = time.Now()
	fs.expirePending()
	fs.mu.Unlock()
	return tree, nil
}

func (fs *edencomFS) invalidate() {
	fs.mu.Lock()
	fs.fetched = time.Time{}
	fs.mu.Unlock()
}

// Drop the aliases that have aged out. Called with the lock held.
//
// Aged out, not "landed": the refresh that follows a restore already lists the
// fit under its real name, so dropping aliases the moment their fit appears
// would retire every one of them instantly — which is exactly the window the
// alias exists to cover. An alias is never in a directory listing, only
// resolvable by name, so a redundant one for half a minute costs nothing.
func (fs *edencomFS) expirePending() {
	kept := fs.pending[:0]
	for _, p := range fs.pending {
		if time.Since(p.created) <= pendingGrace {
			kept = append(kept, p)
		}
	}
	fs.pending = kept
}

func (fs *edencomFS) lookupPending(characterID, name string) ([]byte, bool) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	for _, p := range fs.pending {
		if p.characterID == characterID && strings.EqualFold(p.name, name) && time.Since(p.created) <= pendingGrace {
			return p.content, true
		}
	}
	return nil, false
}

// ── path resolution ──────────────────────────────────────────────────────

type resolved struct {
	root bool
	dir  *vfs.Dir
	file *vfs.File
	// Bytes of a just-restored file not yet in the listing.
	pendingContent []byte
}

func (fs *edencomFS) resolve(path string) (resolved, int) {
	tree, err := fs.snapshot()
	if err != nil {
		log.Printf("listing failed: %v", err)
		return resolved{}, -fuse.EIO
	}
	parts := vfs.Split(path)
	switch len(parts) {
	case 0:
		return resolved{root: true}, 0
	case 1:
		dir, ok := tree.LookupDir(parts[0])
		if !ok {
			return resolved{}, -fuse.ENOENT
		}
		return resolved{dir: dir}, 0
	case 2:
		dir, ok := tree.LookupDir(parts[0])
		if !ok {
			return resolved{}, -fuse.ENOENT
		}
		if file, ok := dir.LookupFile(parts[1]); ok {
			return resolved{dir: dir, file: file}, 0
		}
		if content, ok := fs.lookupPending(folderKey(dir), parts[1]); ok {
			return resolved{dir: dir, pendingContent: content}, 0
		}
		return resolved{}, -fuse.ENOENT
	default:
		// The mount is exactly two levels deep; nothing nests inside a fitting.
		return resolved{}, -fuse.ENOENT
	}
}

// The key a pending alias is filed under: a character's id, or the archive.
func folderKey(dir *vfs.Dir) string {
	if dir.Marshalled {
		return vfs.MarshalledDirName
	}
	return dir.CharacterID
}

// ── attributes ───────────────────────────────────────────────────────────

func (fs *edencomFS) stampDir(stat *fuse.Stat_t, at time.Time, writable bool) {
	mode := uint32(fuse.S_IFDIR | 0o555)
	if writable && !fs.readOnly {
		mode = uint32(fuse.S_IFDIR | 0o755)
	}
	stat.Mode = mode
	stat.Nlink = 2
	fs.stampCommon(stat, at)
}

func (fs *edencomFS) stampFile(stat *fuse.Stat_t, size int64, at time.Time, writable bool) {
	// Read-write only where the character's EVE grant allows a delete: a
	// read-only bit is how `rm` learns it cannot work *before* asking CCP.
	mode := uint32(fuse.S_IFREG | 0o444)
	if writable && !fs.readOnly {
		mode = uint32(fuse.S_IFREG | 0o644)
	}
	stat.Mode = mode
	stat.Nlink = 1
	stat.Size = size
	fs.stampCommon(stat, at)
}

func (fs *edencomFS) stampCommon(stat *fuse.Stat_t, at time.Time) {
	if at.IsZero() {
		at = fs.mounted
	}
	timespec := fuse.NewTimespec(at)
	stat.Uid = fs.uid
	stat.Gid = fs.gid
	stat.Atim = timespec
	stat.Mtim = timespec
	stat.Ctim = timespec
	stat.Birthtim = timespec
}

func (fs *edencomFS) Getattr(path string, stat *fuse.Stat_t, fh uint64) int {
	if handle := fs.handle(fh); handle != nil && handle.writing {
		fs.stampFile(stat, int64(len(handle.buf)), time.Now(), true)
		return 0
	}
	found, errno := fs.resolve(path)
	if errno != 0 {
		return errno
	}
	switch {
	case found.root:
		fs.stampDir(stat, fs.mounted, false)
	case found.file != nil:
		fs.stampFile(stat, int64(len(found.file.Content)), found.file.Modified, found.dir.Writable)
	case found.pendingContent != nil:
		fs.stampFile(stat, int64(len(found.pendingContent)), time.Now(), found.dir.Writable)
	default:
		fs.stampDir(stat, found.dir.Refreshed, found.dir.Writable)
	}
	return 0
}

func (fs *edencomFS) Readdir(
	path string,
	fill func(name string, stat *fuse.Stat_t, ofst int64) bool,
	_ int64,
	_ uint64,
) int {
	found, errno := fs.resolve(path)
	if errno != 0 {
		return errno
	}
	fill(".", nil, 0)
	fill("..", nil, 0)

	if found.root {
		tree, err := fs.snapshot()
		if err != nil {
			return -fuse.EIO
		}
		for i := range tree.Dirs {
			stat := fuse.Stat_t{}
			fs.stampDir(&stat, tree.Dirs[i].Refreshed, tree.Dirs[i].Writable)
			if !fill(tree.Dirs[i].Name, &stat, 0) {
				break
			}
		}
		return 0
	}
	if found.dir == nil || found.file != nil {
		return -fuse.ENOTDIR
	}
	for i := range found.dir.Files {
		file := &found.dir.Files[i]
		stat := fuse.Stat_t{}
		fs.stampFile(&stat, int64(len(file.Content)), file.Modified, found.dir.Writable)
		if !fill(file.Name, &stat, 0) {
			break
		}
	}
	return 0
}

func (fs *edencomFS) Statfs(_ string, stat *fuse.Statfs_t) int {
	// The one number here that means anything is the slot count: EVE lets a
	// character keep 500 fittings, which is the scarce resource this whole
	// filesystem exists to manage. Reporting it as blocks makes `df` answer
	// "how much room is left in game" — 1 block, 1 fitting.
	tree, err := fs.snapshot()
	if err != nil {
		return -fuse.EIO
	}
	const slots = 500
	// The Marshalled folder is the point of having no cap, so it counts for
	// neither side of the budget.
	used, characters := uint64(0), 0
	for i := range tree.Dirs {
		if tree.Dirs[i].Marshalled {
			continue
		}
		used += uint64(len(tree.Dirs[i].Files))
		characters++
	}
	total := uint64(slots) * uint64(max(characters, 1))
	// One block is one fitting slot, sized so plain `df` (which reports in
	// 1K blocks) prints the slot count itself.
	stat.Bsize = 1024
	stat.Frsize = 1024
	stat.Blocks = total
	stat.Bfree = total - min(used, total)
	stat.Bavail = stat.Bfree
	stat.Files = total
	stat.Ffree = stat.Bfree
	stat.Namemax = 255
	return 0
}

// ── reading ──────────────────────────────────────────────────────────────

func (fs *edencomFS) handle(fh uint64) *handle {
	if fh == 0 || fh == ^uint64(0) {
		return nil
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.handles[fh]
}

func (fs *edencomFS) open(h *handle) uint64 {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fh := fs.nextFH
	fs.nextFH++
	fs.handles[fh] = h
	return fh
}

func (fs *edencomFS) Open(path string, flags int) (int, uint64) {
	found, errno := fs.resolve(path)
	if errno != 0 {
		return errno, ^uint64(0)
	}
	if found.root || (found.file == nil && found.pendingContent == nil) {
		return -fuse.EISDIR, ^uint64(0)
	}
	// Editing a fitting in place is not a thing this filesystem does: a fit is
	// changed in the game client, and letting a text editor write half of one
	// back would be a way to lose it. Copy it out, delete it, copy a new one in.
	if flags&(fuse.O_WRONLY|fuse.O_RDWR|fuse.O_APPEND) != 0 {
		return -fuse.EACCES, ^uint64(0)
	}
	content := found.pendingContent
	if found.file != nil {
		content = found.file.Content
	}
	return 0, fs.open(&handle{dir: found.dir, content: content})
}

func (fs *edencomFS) Read(path string, dest []byte, offset int64, fh uint64) int {
	h := fs.handle(fh)
	var content []byte
	if h != nil && !h.writing {
		content = h.content
	} else if h != nil {
		content = h.buf
	} else {
		found, errno := fs.resolve(path)
		if errno != 0 {
			return errno
		}
		if found.file == nil {
			return -fuse.EISDIR
		}
		content = found.file.Content
	}
	if offset >= int64(len(content)) {
		return 0
	}
	return copy(dest, content[offset:])
}

func (fs *edencomFS) Release(_ string, fh uint64) int {
	fs.mu.Lock()
	delete(fs.handles, fh)
	fs.mu.Unlock()
	return 0
}

// ── archiving: rm ────────────────────────────────────────────────────────

func (fs *edencomFS) Unlink(path string) int {
	found, errno := fs.resolve(path)
	if errno != 0 {
		return errno
	}
	if found.file == nil {
		// A pending restore that hasn't landed in a listing yet, or a directory.
		if found.pendingContent != nil {
			return -fuse.EBUSY
		}
		return -fuse.EISDIR
	}
	if errno := fs.writable(found.dir); errno != 0 {
		return errno
	}

	// `rm` in the archive is the one permanent thing here, and it is only
	// permanent on the server: a fit that came through an EVE delete is in the
	// write log, one copied in is on this disk.
	if found.dir.Marshalled {
		log.Printf("removing %q from the archive (%s)", found.file.Name, found.file.ContentHash)
		if err := fs.client.DeleteMarshalled(fs.requests, found.file.ContentHash); err != nil {
			log.Printf("archive delete failed: %v", err)
			fs.invalidate()
			return errnoFor(err)
		}
		fs.invalidate()
		return 0
	}

	log.Printf("archiving %q from %s: deleting fitting %d in EVE", found.file.Name, found.dir.Pilot(), found.file.FittingID)
	if err := fs.client.Archive(fs.requests, found.dir.CharacterID, found.file.FittingID); err != nil {
		log.Printf("archive failed: %v", err)
		fs.invalidate()
		return errnoFor(err)
	}
	fs.invalidate()
	return 0
}

// ── restoring: cp into a character's folder ──────────────────────────────

func (fs *edencomFS) Create(path string, _ int, _ uint32) (int, uint64) {
	parts := vfs.Split(path)
	if len(parts) != 2 {
		return -fuse.EPERM, ^uint64(0)
	}
	tree, err := fs.snapshot()
	if err != nil {
		return -fuse.EIO, ^uint64(0)
	}
	dir, ok := tree.LookupDir(parts[0])
	if !ok {
		return -fuse.ENOENT, ^uint64(0)
	}
	if errno := fs.writable(dir); errno != 0 {
		return errno, ^uint64(0)
	}
	// Dotfiles are the file browser talking to itself (.DS_Store, ._resource
	// forks, .Trashes). None of them is a fitting, and each would otherwise be
	// POSTed at CCP. Mount with -o noappledouble as well; this is the backstop.
	if strings.HasPrefix(parts[1], ".") {
		return -fuse.EPERM, ^uint64(0)
	}
	if _, exists := dir.LookupFile(parts[1]); exists {
		return -fuse.EEXIST, ^uint64(0)
	}
	return 0, fs.open(&handle{dir: dir, name: parts[1], writing: true})
}

func (fs *edencomFS) Write(_ string, buf []byte, offset int64, fh uint64) int {
	h := fs.handle(fh)
	if h == nil || !h.writing {
		return -fuse.EACCES
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	end := offset + int64(len(buf))
	// Writes need not arrive in order, and a sparse gap would be a hole in a
	// JSON document — zero-filling keeps it a parse failure the server names
	// rather than something subtly wrong that reaches the game.
	if end > int64(len(h.buf)) {
		grown := make([]byte, end)
		copy(grown, h.buf)
		h.buf = grown
	}
	copy(h.buf[offset:end], buf)
	return len(buf)
}

func (fs *edencomFS) Truncate(_ string, size int64, fh uint64) int {
	h := fs.handle(fh)
	if h == nil || !h.writing {
		return -fuse.EACCES
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	switch {
	case size < int64(len(h.buf)):
		h.buf = h.buf[:size]
	case size > int64(len(h.buf)):
		grown := make([]byte, size)
		copy(grown, h.buf)
		h.buf = grown
	}
	return 0
}

// Flush, not Release, is where the restore happens: close(2) reports what Flush
// returns, and Release's result is thrown away. A copy that CCP refuses has to
// fail the `cp`, not succeed quietly and leave the player believing their fit is
// back in game.
func (fs *edencomFS) Flush(_ string, fh uint64) int {
	h := fs.handle(fh)
	if h == nil || !h.writing || h.finished {
		return 0
	}
	// Marked finished up front so a second close (or the Release that follows)
	// cannot POST the same fit twice.
	h.finished = true

	if len(h.buf) == 0 {
		// `touch` and some editors create an empty file first. Nothing to
		// restore, and nothing was promised.
		return 0
	}

	if h.dir.Marshalled {
		// A copy INTO the archive stores the file on the server and asks nothing
		// of CCP: this is how a disk archive moves into the account.
		log.Printf("storing %q in the archive (%d bytes)", h.name, len(h.buf))
		stored, err := fs.client.PutMarshalled(fs.requests, h.buf)
		if err != nil {
			log.Printf("archive store failed: %v", err)
			return errnoFor(err)
		}
		if stored.Created {
			log.Printf("stored %q in the archive as %s", h.name, stored.ContentHash)
		} else {
			log.Printf("the archive already held %q (%s); nothing to do", h.name, stored.ContentHash)
		}
	} else {
		log.Printf("restoring %q into %s (%d bytes)", h.name, h.dir.Pilot(), len(h.buf))
		restored, err := fs.client.Restore(fs.requests, h.dir.CharacterID, h.buf)
		if err != nil {
			log.Printf("restore failed: %v", err)
			return errnoFor(err)
		}
		if restored.Created {
			log.Printf("restored %q into %s as fitting %d", h.name, h.dir.Pilot(), restored.FittingID)
		} else {
			log.Printf("%s already had that fitting saved (%d); nothing to do", h.dir.Pilot(), restored.FittingID)
		}
	}

	fs.mu.Lock()
	fs.pending = append(fs.pending, pending{
		characterID: folderKey(h.dir),
		name:        h.name,
		content:     append([]byte(nil), h.buf...),
		created:     time.Now(),
	})
	fs.fetched = time.Time{}
	fs.mu.Unlock()
	return 0
}

func (fs *edencomFS) Fsync(_ string, _ bool, fh uint64) int { return fs.Flush("", fh) }

// Metadata a copy sets on its way past. There is nothing behind them — a
// fitting has no permissions and its timestamps come from the game — but
// refusing them makes `cp -p` and Finder report failures for a copy that
// actually worked, so they are accepted and dropped.
func (fs *edencomFS) Chmod(string, uint32) int            { return 0 }
func (fs *edencomFS) Chown(string, uint32, uint32) int    { return 0 }
func (fs *edencomFS) Utimens(string, []fuse.Timespec) int { return 0 }

// ── moving: mv between folders ───────────────────────────────────────────
//
// A rename is the one place the three verbs of docs/fitting-marshal.md meet
// the filesystem. Which folders a file moves between decides what it means
// (vfs.ClassifyRename); the target name is ignored, since a fit's identity is
// its content and the mount names files itself. Anything else is EPERM, never
// EXDEV: EXDEV makes `mv` fall back to copy-then-unlink, and inside the
// archive that would be a PUT of the same content followed by a DELETE of it.
func (fs *edencomFS) Rename(oldPath, newPath string) int {
	found, errno := fs.resolve(oldPath)
	if errno != 0 {
		return errno
	}
	if found.file == nil {
		if found.pendingContent != nil {
			return -fuse.EBUSY
		}
		return -fuse.EPERM
	}
	parts := vfs.Split(newPath)
	if len(parts) != 2 || strings.HasPrefix(parts[1], ".") {
		return -fuse.EPERM
	}
	tree, err := fs.snapshot()
	if err != nil {
		return -fuse.EIO
	}
	to, ok := tree.LookupDir(parts[0])
	if !ok {
		return -fuse.ENOENT
	}
	if fs.readOnly {
		return -fuse.EROFS
	}

	switch vfs.ClassifyRename(found.dir, to) {
	case vfs.RenameMarshal:
		if errno := fs.writable(found.dir); errno != 0 {
			return errno
		}
		log.Printf("marshalling %q from %s: deleting fitting %d in EVE, keeping it on the server",
			found.file.Name, found.dir.Pilot(), found.file.FittingID)
		hash, err := fs.client.Marshal(fs.requests, found.dir.CharacterID, found.file.FittingID)
		fs.invalidate()
		if err != nil {
			log.Printf("marshal failed: %v", err)
			return errnoFor(err)
		}
		log.Printf("marshalled %q as %s", found.file.Name, hash)
		return 0

	case vfs.RenameUnmarshal:
		if errno := fs.writable(to); errno != 0 {
			return errno
		}
		log.Printf("unmarshalling %q into %s", found.file.Name, to.Pilot())
		restored, err := fs.client.Restore(fs.requests, to.CharacterID, found.file.Content)
		if err != nil {
			log.Printf("unmarshal failed, the fit stays in the archive: %v", err)
			fs.invalidate()
			return errnoFor(err)
		}
		log.Printf("unmarshalled %q into %s as fitting %d (created: %v)", found.file.Name, to.Pilot(), restored.FittingID, restored.Created)
		if err := fs.client.DeleteMarshalled(fs.requests, found.file.ContentHash); err != nil {
			// The fit is in the game AND still in the archive: nothing lost,
			// and the next `rm` in the archive finishes the move.
			log.Printf("saved in EVE but the archive would not let go of it: %v", err)
			fs.invalidate()
			return errnoFor(err)
		}
		fs.invalidate()
		return 0

	case vfs.RenameTransfer:
		if errno := fs.writable(found.dir); errno != 0 {
			return errno
		}
		if errno := fs.writable(to); errno != 0 {
			return errno
		}
		log.Printf("transferring %q from %s to %s", found.file.Name, found.dir.Pilot(), to.Pilot())
		restored, err := fs.client.Restore(fs.requests, to.CharacterID, found.file.Content)
		if err != nil {
			log.Printf("transfer failed before anything moved: %v", err)
			fs.invalidate()
			return errnoFor(err)
		}
		log.Printf("saved on %s as fitting %d (created: %v)", to.Pilot(), restored.FittingID, restored.Created)
		if err := fs.client.Archive(fs.requests, found.dir.CharacterID, found.file.FittingID); err != nil {
			// Saved on the target, still on the source: safe, retryable, and
			// reported rather than undone. `rm` the original to finish.
			log.Printf("saved on %s but EVE would not delete it from %s: %v", to.Pilot(), found.dir.Pilot(), err)
			fs.invalidate()
			return errnoFor(err)
		}
		fs.invalidate()
		return 0

	default:
		return -fuse.EPERM
	}
}

// Everything else that would reshape the mount itself. The structure is EVE's
// plus the archive: characters are folders because EVE has characters, and
// there are no subfolders because a fitting library has no folders in game.
func (fs *edencomFS) Mkdir(string, uint32) int   { return -fuse.EPERM }
func (fs *edencomFS) Rmdir(string) int           { return -fuse.EPERM }
func (fs *edencomFS) Link(string, string) int    { return -fuse.EPERM }
func (fs *edencomFS) Symlink(string, string) int { return -fuse.EPERM }

func (fs *edencomFS) writable(dir *vfs.Dir) int {
	if fs.readOnly {
		return -fuse.EROFS
	}
	if !dir.Writable {
		log.Printf(
			"%s has not granted permission to save and delete fittings — turn it on under /settings/grants and re-auth the character on /account/registrations",
			dir.Pilot(),
		)
		return -fuse.EACCES
	}
	return 0
}

// The errno a failed API call becomes. A filesystem can only say a number, so
// the sentence the server wrote goes to the log and the number is chosen to be
// the least misleading one available.
func errnoFor(err error) int {
	switch link.StatusOf(err) {
	case 401, 403:
		return -fuse.EACCES
	case 400:
		return -fuse.EINVAL
	case 404:
		return -fuse.ENOENT
	case 409:
		// The restore key was already used. The client mints a fresh one per
		// attempt, so this means a genuine collision rather than a retry, and
		// EEXIST is the honest word for it.
		return -fuse.EEXIST
	case 507:
		// The character's 500 in-game slots are full: exactly "no space left".
		return -fuse.ENOSPC
	default:
		return -fuse.EIO
	}
}
