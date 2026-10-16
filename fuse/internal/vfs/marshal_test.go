package vfs

import (
	"testing"
	"time"
)

// The hash has to agree with the server's src/fittingArchive.ts contentHash
// byte for byte — it is the address a PUT lands at. These vectors were
// produced by that module (node, 2026-10-16) and pin: HTML characters left
// unescaped, a newline and quotes in the description, items sorted as
// "flag:type_id" STRINGS (so "HiSlot0:2048" precedes "HiSlot0:300"), and
// order-independence of the input.
func TestContentHashMatchesTheServer(t *testing.T) {
	a := Fitting{
		Name:        "Rifter <cheap> & fast",
		Description: "line one\nline two \"quoted\"",
		ShipTypeID:  587,
		Items: []Item{
			{TypeID: 300, Flag: "HiSlot0", Quantity: 1},
			{TypeID: 2048, Flag: "HiSlot0", Quantity: 1},
			{TypeID: 31718, Flag: "Cargo", Quantity: 500},
		},
	}
	const wantA = "95735fa18e0b4f6f8050db29d63a7edcab3fe4cf5f7326490436539475fca123"
	if got := ContentHash(a); got != wantA {
		t.Errorf("ContentHash(a) = %s, want %s", got, wantA)
	}

	reversed := a
	reversed.Items = []Item{a.Items[2], a.Items[1], a.Items[0]}
	if got := ContentHash(reversed); got != wantA {
		t.Errorf("item order changed the hash: %s", got)
	}

	b := Fitting{Name: "Doctrine Cane", ShipTypeID: 24702}
	const wantB = "4751594f6327405a8f253ca6866f6b82640e96a691c7588a58e0b4c2ccf2bf5b"
	if got := ContentHash(b); got != wantB {
		t.Errorf("ContentHash(b) = %s, want %s", got, wantB)
	}
}

func TestContentHashIgnoresTheGameIdAndTheMountsOwnFields(t *testing.T) {
	// fitting_id is a frame number, ship_name and modified are decoration:
	// none of them is the fit.
	base := Fitting{Name: "X", ShipTypeID: 1}
	decorated := base
	decorated.FittingID = 99
	decorated.ShipName = "Rifter"
	decorated.Modified = time.Unix(1700000000, 0)
	if ContentHash(base) != ContentHash(decorated) {
		t.Error("the hash depends on something that is not the fit's content")
	}
}

func TestParseFileTrimsTheNameAsTheServerDoes(t *testing.T) {
	// The server's parseArchiveFitting trims the name before hashing, so a
	// padded name in a file must hash to the trimmed form here too, or the
	// PUT lands at the wrong address.
	padded, err := ParseFile([]byte(`{"fitting_id": 4, "name": "  Doctrine Cane  ", "description": "", "ship_type_id": 24702, "items": [], "extra": true}`))
	if err != nil {
		t.Fatal(err)
	}
	if padded.Name != "Doctrine Cane" || padded.FittingID != 4 || padded.ShipTypeID != 24702 {
		t.Errorf("parsed = %+v", padded)
	}
	if got := ContentHash(padded); got != "4751594f6327405a8f253ca6866f6b82640e96a691c7588a58e0b4c2ccf2bf5b" {
		t.Errorf("padded name hashed differently: %s", got)
	}
	if _, err := ParseFile([]byte("not json")); err == nil {
		t.Error("a non-JSON file parsed")
	}
}

func TestBuildTreeAddsTheMarshalledFolderLast(t *testing.T) {
	hash := "4751594f6327405a8f253ca6866f6b82640e96a691c7588a58e0b4c2ccf2bf5b"
	tree := BuildTree(
		[]Character{{CharacterID: "1", Name: "Philihp", Writable: false, Fittings: []Fitting{fit(1, "Rifter", "A")}}},
		[]Fitting{{Name: "Doctrine Cane", ShipTypeID: 24702, ShipName: "Hurricane", ContentHash: hash, FittingID: 42,
			Modified: time.Unix(1700000000, 0).UTC()}},
	)
	if len(tree.Dirs) != 2 || tree.Dirs[0].CharacterID != "1" {
		t.Fatalf("dirs = %+v", tree.Dirs)
	}
	archive := tree.Dirs[1]
	if !archive.Marshalled || archive.Name != MarshalledDirName || !archive.Writable || archive.CharacterID != "" {
		t.Errorf("archive dir = %+v", archive)
	}
	if len(archive.Files) != 1 || archive.Files[0].Name != "Hurricane - Doctrine Cane.json" || archive.Files[0].ContentHash != hash {
		t.Errorf("archive files = %+v", archive.Files)
	}
	// The newest fit stamps the folder.
	if !archive.Refreshed.Equal(time.Unix(1700000000, 0)) {
		t.Errorf("archive refreshed = %v", archive.Refreshed)
	}
	// Case-insensitive lookup, like a character folder.
	if dir, ok := tree.LookupDir("marshalled"); !ok || dir != &tree.Dirs[1] {
		t.Error("the archive folder does not resolve by name")
	}
	// The file carries the fit's last game id, ignored on restore.
	if file, ok := archive.LookupFile("hurricane - doctrine cane.json"); !ok || file.FittingID != 42 {
		t.Error("the archive file does not resolve, or lost its provenance id")
	}
}

func TestMarshalledFolderOwnsItsNameAheadOfACharacter(t *testing.T) {
	tree := BuildTree([]Character{{CharacterID: "7", Name: "Marshalled"}}, nil)
	if len(tree.Dirs) != 2 {
		t.Fatalf("dirs = %+v", tree.Dirs)
	}
	if tree.Dirs[0].Name != "Marshalled (2)" || tree.Dirs[0].CharacterID != "7" {
		t.Errorf("the character took the archive's name: %+v", tree.Dirs[0])
	}
	if tree.Dirs[1].Name != MarshalledDirName || !tree.Dirs[1].Marshalled {
		t.Errorf("the archive lost its name: %+v", tree.Dirs[1])
	}
}

func TestMarshalledFolderIsPresentWhenEmpty(t *testing.T) {
	// A first `cp` into the archive needs somewhere to land.
	tree := BuildTree(nil, nil)
	if len(tree.Dirs) != 1 || !tree.Dirs[0].Marshalled || len(tree.Dirs[0].Files) != 0 {
		t.Fatalf("dirs = %+v", tree.Dirs)
	}
}

func TestMarshalledFileNamesFallBackToTheHash(t *testing.T) {
	// A nameless marshalled fit has no game id to name it by (a file copied
	// in never had one), so the first eight hex of its hash stand in.
	hash := "4751594f6327405a8f253ca6866f6b82640e96a691c7588a58e0b4c2ccf2bf5b"
	if got := FileName(Fitting{ShipName: "Hurricane", ContentHash: hash}); got != "Hurricane - fitting 4751594f.json" {
		t.Errorf("got %q", got)
	}
	// Two marshalled fits with the same name on the same hull still get
	// distinct, stable names, assigned in hash order.
	tree := BuildTree(nil, []Fitting{
		{Name: "PVP", ShipName: "Rifter", ShipTypeID: 587, ContentHash: "b" + hash[1:]},
		{Name: "PVP", ShipName: "Rifter", ShipTypeID: 587, ContentHash: "a" + hash[1:]},
	})
	files := tree.Dirs[0].Files
	if len(files) != 2 || files[0].Name != "Rifter - PVP (2).json" && files[1].Name != "Rifter - PVP (2).json" {
		t.Fatalf("files = %+v", files)
	}
	// The " (2)" lands on the hash that sorts second, whatever order the
	// listing came in.
	for _, f := range files {
		if f.Name == "Rifter - PVP (2).json" && f.ContentHash != "b"+hash[1:] {
			t.Errorf("the suffix landed on the wrong fit: %+v", f)
		}
	}
}

func TestClassifyRename(t *testing.T) {
	alice := &Dir{CharacterID: "1"}
	bob := &Dir{CharacterID: "2"}
	archive := &Dir{Marshalled: true}
	cases := []struct {
		name     string
		from, to *Dir
		want     RenameKind
	}{
		{"character to archive is marshal", alice, archive, RenameMarshal},
		{"archive to character is unmarshal", archive, alice, RenameUnmarshal},
		{"character to another character is transfer", alice, bob, RenameTransfer},
		{"within a character folder is unsupported", alice, alice, RenameUnsupported},
		{"within the archive is unsupported", archive, archive, RenameUnsupported},
		{"a missing folder is unsupported", alice, nil, RenameUnsupported},
	}
	for _, c := range cases {
		if got := ClassifyRename(c.from, c.to); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
