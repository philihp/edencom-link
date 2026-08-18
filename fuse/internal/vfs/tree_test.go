package vfs

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func fit(id int64, ship, name string) Fitting {
	return Fitting{
		FittingID:  id,
		Name:       name,
		ShipTypeID: 587,
		ShipName:   ship,
		Items:      []Item{{TypeID: 2048, Flag: "LoSlot0", Quantity: 1}},
		Modified:   time.Unix(1700000000, 0).UTC(),
	}
}

func TestSanitizeKeepsNamesToOnePathComponent(t *testing.T) {
	cases := map[string]string{
		"Doctrine Rifter": "Doctrine Rifter",
		"AC/DC Rifter":    "AC-DC Rifter",
		// Every separator becomes a dash, so a traversal attempt collapses into
		// one harmless (if ugly) filename rather than escaping the folder.
		"../../etc/passwd": "-..-etc-passwd",
		`back\slash`:       "back-slash",
		"colon: here":      "colon- here",
		"  padded  ":       "padded",
		".hidden":          "hidden",
		"..":               "",
		".":                "",
		"":                 "",
		"tab\there":        "tab here",
	}
	for input, want := range cases {
		if got := Sanitize(input); got != want {
			t.Errorf("Sanitize(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSanitizeNeverLeavesAPathSeparator(t *testing.T) {
	for _, input := range []string{"a/b", "a\\b", "///", "\x00null"} {
		got := Sanitize(input)
		if strings.ContainsAny(got, "/\\\x00") {
			t.Errorf("Sanitize(%q) = %q, still contains a separator", input, got)
		}
	}
}

func TestFileNameLeadsWithTheHull(t *testing.T) {
	if got := FileName(fit(1, "Rifter", "Cheap Tackle")); got != "Rifter - Cheap Tackle.json" {
		t.Errorf("got %q", got)
	}
	// An unmirrored hull (a type the SDE mirror hasn't caught up with) still
	// produces a usable name rather than a leading separator.
	if got := FileName(fit(1, "", "Cheap Tackle")); got != "Cheap Tackle.json" {
		t.Errorf("got %q", got)
	}
	// A fit whose name sanitizes away entirely is still addressable.
	if got := FileName(fit(9, "Rifter", "..")); got != "Rifter - fitting 9.json" {
		t.Errorf("got %q", got)
	}
}

func TestDuplicateFitNamesBecomeDistinctFiles(t *testing.T) {
	tree := BuildTree([]Character{{
		CharacterID: "1",
		Name:        "Philihp",
		Writable:    true,
		Fittings:    []Fitting{fit(3, "Rifter", "PVP"), fit(1, "Rifter", "PVP"), fit(2, "Rifter", "PVP")},
	}})
	dir, ok := tree.LookupDir("Philihp")
	if !ok {
		t.Fatal("no directory for the character")
	}
	if len(dir.Files) != 3 {
		t.Fatalf("got %d files, want 3", len(dir.Files))
	}
	names := map[string]bool{}
	for _, file := range dir.Files {
		if names[file.Name] {
			t.Fatalf("duplicate filename %q", file.Name)
		}
		names[file.Name] = true
	}
	// Suffixes go by fitting id, not by the order the API listed them, so the
	// same library mounts the same way every time.
	byName := map[string]int64{}
	for _, file := range dir.Files {
		byName[file.Name] = file.FittingID
	}
	if byName["Rifter - PVP.json"] != 1 || byName["Rifter - PVP (2).json"] != 2 || byName["Rifter - PVP (3).json"] != 3 {
		t.Errorf("suffixes not assigned by fitting id: %v", byName)
	}
}

func TestBuildTreeIsDeterministic(t *testing.T) {
	characters := []Character{{
		CharacterID: "1",
		Name:        "Philihp",
		Fittings:    []Fitting{fit(2, "Rifter", "PVP"), fit(1, "Rifter", "PVP"), fit(3, "Hurricane", "Doctrine")},
	}}
	first := BuildTree(characters)
	second := BuildTree(characters)
	for i := range first.Dirs {
		for j := range first.Dirs[i].Files {
			if first.Dirs[i].Files[j].Name != second.Dirs[i].Files[j].Name {
				t.Fatalf("filenames differ between builds: %q vs %q",
					first.Dirs[i].Files[j].Name, second.Dirs[i].Files[j].Name)
			}
		}
	}
	// Alphabetical, so the hull-first naming groups the listing by ship. (The
	// deduplicating suffix sorts before the plain name, since a space beats a
	// dot — cosmetic, and `ls` re-sorts anyway.)
	got := []string{}
	for _, file := range first.Dirs[0].Files {
		got = append(got, file.Name)
	}
	want := []string{"Hurricane - Doctrine.json", "Rifter - PVP (2).json", "Rifter - PVP.json"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("listing order %v, want %v", got, want)
		}
	}
}

func TestCharactersWithTheSameNameGetSeparateFolders(t *testing.T) {
	// Two accounts' worth of alts can genuinely collide, and a folder that
	// silently absorbed another character's fits would be a way to delete the
	// wrong pilot's fitting.
	tree := BuildTree([]Character{
		{CharacterID: "1", Name: "Philihp", Fittings: []Fitting{fit(1, "Rifter", "A")}},
		{CharacterID: "2", Name: "Philihp", Fittings: []Fitting{fit(1, "Rifter", "B")}},
	})
	if len(tree.Dirs) != 2 || tree.Dirs[0].Name == tree.Dirs[1].Name {
		t.Fatalf("folders collided: %v", tree.Dirs)
	}
	second, ok := tree.LookupDir(tree.Dirs[1].Name)
	if !ok || second.CharacterID != "2" {
		t.Fatal("the second folder does not resolve to the second character")
	}
}

func TestLookupIsCaseInsensitive(t *testing.T) {
	tree := BuildTree([]Character{{CharacterID: "1", Name: "Philihp", Fittings: []Fitting{fit(1, "Rifter", "PVP")}}})
	dir, ok := tree.LookupDir("PHILIHP")
	if !ok {
		t.Fatal("directory lookup is case sensitive")
	}
	if _, ok := dir.LookupFile("rifter - pvp.json"); !ok {
		t.Fatal("file lookup is case sensitive")
	}
}

func TestRenderIsTheEsiObjectAndNothingElse(t *testing.T) {
	content := Render(fit(12, "Rifter", "Cheap Tackle"))
	if !strings.HasSuffix(string(content), "}\n") {
		t.Errorf("archive file should end with a newline: %q", string(content))
	}

	var parsed map[string]any
	if err := json.Unmarshal(content, &parsed); err != nil {
		t.Fatalf("archive file is not valid JSON: %v", err)
	}
	keys := []string{}
	for key := range parsed {
		keys = append(keys, key)
	}
	if len(keys) != 5 {
		t.Fatalf("archive file carries %v, want exactly ESI's five fields", keys)
	}
	for _, key := range []string{"fitting_id", "name", "description", "ship_type_id", "items"} {
		if _, ok := parsed[key]; !ok {
			t.Errorf("archive file is missing %q", key)
		}
	}
	// Nothing of the mount's own leaks into the file the player keeps.
	for _, key := range []string{"ship_name", "modified"} {
		if _, ok := parsed[key]; ok {
			t.Errorf("archive file should not carry %q", key)
		}
	}
}

func TestRenderLeavesNamesAlone(t *testing.T) {
	// Go's JSON encoder escapes <, > and & by default, which would turn a fit
	// called "Rifter <cheap>" into one called "Rifter <cheap>" —
	// still valid JSON, but not the name the player typed, and a needless diff
	// against the same fit exported by anything else.
	content := string(Render(fit(1, "Rifter", "Rifter <cheap> & fast")))
	if !strings.Contains(content, "Rifter <cheap> & fast") {
		t.Errorf("name was escaped: %s", content)
	}
}

func TestRenderGivesAnEmptyHullAnEmptyItemList(t *testing.T) {
	// A hull saved with nothing fitted must render "items": [], not null —
	// null is what ESI rejects on the way back in.
	bare := fit(1, "Rifter", "Bare")
	bare.Items = nil
	if !strings.Contains(string(Render(bare)), `"items": []`) {
		t.Errorf("got %s", string(Render(bare)))
	}
}

func TestSplitHandlesEveryPathTheKernelHandsDown(t *testing.T) {
	cases := map[string][]string{
		"/":               nil,
		"":                nil,
		"/Philihp":        {"Philihp"},
		"/Philihp/a.json": {"Philihp", "a.json"},
	}
	for path, want := range cases {
		got := Split(path)
		if len(got) != len(want) {
			t.Fatalf("Split(%q) = %v, want %v", path, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("Split(%q) = %v, want %v", path, got, want)
			}
		}
	}
}
