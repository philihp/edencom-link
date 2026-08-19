package vfs

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Tree is one snapshot of the mount: every directory and file that exists right
// now, with the mapping back to the ids the API needs. Immutable once built —
// the filesystem swaps in a whole new Tree when the listing is refreshed, so a
// read in flight never sees half of an update.
type Tree struct {
	Dirs  []Dir
	byDir map[string]*Dir
}

// Dir is one character's folder.
type Dir struct {
	// The folder name, sanitized and made unique.
	Name string
	// The EVE numeric character id, which is what the API paths carry.
	CharacterID string
	// False when this character's EVE token does not carry the write scope:
	// their fits can be read and copied out, but not deleted or restored.
	Writable bool
	// When the mirror behind this character's listing was last refreshed.
	Refreshed time.Time

	Files  []File
	byFile map[string]*File
	pilot  string
}

// File is one saved fitting, as a file.
type File struct {
	Name      string
	FittingID int64
	Content   []byte
	Modified  time.Time
}

// Characters whose names collide, fits whose names collide, and a fit called
// "../../etc/passwd" all have to end up as distinct, harmless names — so
// building a tree is three passes: sanitize, uniquify, index.

// Sanitize turns an arbitrary EVE name into something that can be one path
// component. EVE lets a fitting be called almost anything, including "/" and a
// leading dot; a mount is not the place to find out what the kernel does with
// that.
//
// The empty result is caller-handled (it becomes "unnamed"), because a fit
// named entirely out of forbidden characters is not an error, just unlucky.
func Sanitize(name string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(name) {
		switch {
		// Path separators, the character macOS shows as one in Finder, and the
		// NUL that would truncate the name inside the C layer.
		case r == '/' || r == '\\' || r == ':' || r == 0:
			b.WriteRune('-')
		// Control characters have no business in a filename and would render as
		// garbage in every file browser.
		case r < 0x20 || r == 0x7f:
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	cleaned := strings.Join(strings.Fields(b.String()), " ")
	// "." and ".." are the two names a directory always already has.
	if cleaned == "." || cleaned == ".." {
		return ""
	}
	// A leading dot would hide the entry from ls and Finder — never what a
	// player named a fit for.
	cleaned = strings.TrimLeft(cleaned, ".")
	return strings.TrimSpace(cleaned)
}

// FileName is the filename for one fitting: hull first, then the player's own
// name for the fit.
//
// Hull first because that is how a fitting library is actually browsed — "what
// do I have for a Hurricane" is the question, and it makes an alphabetical
// directory listing group by ship for free. The name is the fit's, so a file
// copied to the archive and read back a year later still says what it is.
func FileName(f Fitting) string {
	name := Sanitize(f.Name)
	if name == "" {
		name = fmt.Sprintf("fitting %d", f.FittingID)
	}
	ship := Sanitize(f.ShipName)
	if ship == "" {
		return name + ".json"
	}
	return ship + " - " + name + ".json"
}

// uniquify appends " (2)", " (3)" … to duplicates, before the extension.
//
// Two fits can genuinely have the same name on the same hull — players do it
// constantly, saving "Hurricane - PVP" over and over. The suffix is assigned in
// the order given, and callers sort by fitting id first, so the same library
// produces the same names on every mount rather than shuffling between refreshes.
func uniquify(taken map[string]bool, name string) string {
	if !taken[strings.ToLower(name)] {
		taken[strings.ToLower(name)] = true
		return name
	}
	stem, ext := name, ""
	if dot := strings.LastIndex(name, "."); dot > 0 {
		stem, ext = name[:dot], name[dot:]
	}
	for n := 2; ; n++ {
		candidate := fmt.Sprintf("%s (%d)%s", stem, n, ext)
		if !taken[strings.ToLower(candidate)] {
			taken[strings.ToLower(candidate)] = true
			return candidate
		}
	}
}

// BuildTree turns an API listing into the mount's directory structure.
func BuildTree(characters []Character) *Tree {
	tree := &Tree{byDir: map[string]*Dir{}}
	takenDirs := map[string]bool{}

	// Characters in the order the API gave them (by name), so the root listing
	// is stable across refreshes.
	for _, character := range characters {
		name := Sanitize(character.Name)
		if name == "" {
			name = "character " + character.CharacterID
		}
		dir := Dir{
			Name:        uniquify(takenDirs, name),
			CharacterID: character.CharacterID,
			Writable:    character.Writable,
			Refreshed:   character.Refreshed,
			pilot:       character.Name,
			byFile:      map[string]*File{},
		}

		// Sorted by fitting id, so the " (2)" suffixes land on the same fits
		// every time regardless of how the listing happened to be ordered.
		fits := append([]Fitting(nil), character.Fittings...)
		sort.Slice(fits, func(i, j int) bool { return fits[i].FittingID < fits[j].FittingID })

		takenFiles := map[string]bool{}
		for _, fit := range fits {
			dir.Files = append(dir.Files, File{
				Name:      uniquify(takenFiles, FileName(fit)),
				FittingID: fit.FittingID,
				Content:   Render(fit),
				Modified:  fit.Modified,
			})
		}
		// Alphabetical, which is what a file browser shows anyway and what makes
		// the hull-first naming pay off.
		sort.Slice(dir.Files, func(i, j int) bool {
			return strings.ToLower(dir.Files[i].Name) < strings.ToLower(dir.Files[j].Name)
		})

		tree.Dirs = append(tree.Dirs, dir)
	}

	// Index after every Dir is in place: taking a pointer into a slice that is
	// still being appended to would be a pointer into a dead backing array.
	for i := range tree.Dirs {
		dir := &tree.Dirs[i]
		tree.byDir[strings.ToLower(dir.Name)] = dir
		for j := range dir.Files {
			file := &dir.Files[j]
			dir.byFile[strings.ToLower(file.Name)] = file
		}
	}
	return tree
}

// Pilot is the character's name as EVE spells it, before sanitizing.
func (d *Dir) Pilot() string { return d.pilot }

// LookupDir finds a character's folder by the name it has in the mount.
// Case-insensitively, because macOS filesystems are, and a player typing
// `cd philihp` should not be told there is no such directory.
func (t *Tree) LookupDir(name string) (*Dir, bool) {
	dir, ok := t.byDir[strings.ToLower(name)]
	return dir, ok
}

// LookupFile finds one fitting's file within a character's folder.
func (d *Dir) LookupFile(name string) (*File, bool) {
	file, ok := d.byFile[strings.ToLower(name)]
	return file, ok
}

// Split breaks a mount path into its at most two components. FUSE always hands
// down absolute, already-cleaned paths, so this is a split rather than a parse.
func Split(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}
