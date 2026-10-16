// Package vfs holds everything about the shape of the mounted filesystem that
// does not need a kernel: what a character's folder is called, what a fitting's
// file is called, and exactly which bytes are in it.
//
// It is deliberately free of cgofuse and of the network, because those are the
// two parts that cannot be tested on a build machine. Everything with a rule in
// it — sanitizing, deduplicating and rendering — lives here and is covered by
// vfs_test.go; fs.go next door is the thin part that only translates.
package vfs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Item is one fitted module, charge or drone, in ESI's own shape.
type Item struct {
	TypeID   int64  `json:"type_id"`
	Flag     string `json:"flag"`
	Quantity int64  `json:"quantity"`
}

// Fitting is one saved fit as /api/fittings lists it: ESI's fitting object,
// plus the hull name and modification time that only make the mount nicer to
// browse and are never written into a file.
type Fitting struct {
	FittingID   int64  `json:"fitting_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	ShipTypeID  int64  `json:"ship_type_id"`
	Items       []Item `json:"items"`

	ShipName string    `json:"ship_name"`
	Modified time.Time `json:"modified"`
	// The server's handle for a marshalled fit; empty on a live one, whose
	// handle is its FittingID.
	ContentHash string `json:"content_hash"`
}

// Character is one linked EVE character and everything they have saved.
type Character struct {
	CharacterID string    `json:"character_id"`
	Name        string    `json:"name"`
	Writable    bool      `json:"writable"`
	Refreshed   time.Time `json:"data_refreshed"`
	Fittings    []Fitting `json:"fittings"`
}

// archiveFitting is the file's contents: ESI's fitting object and nothing else.
// Its field order is the file's key order, and the tags leave out everything
// Fitting carries for the mount's own benefit.
type archiveFitting struct {
	FittingID   int64  `json:"fitting_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	ShipTypeID  int64  `json:"ship_type_id"`
	Items       []Item `json:"items"`
}

// Render returns the bytes of one fitting's archive file.
//
// Rendered here rather than fetched per file, for two reasons. A mount is up to
// 500 fits per character and the listing already carries every field, so asking
// the server again for each one would turn a directory into 500 round trips.
// And it makes the file's bytes a function of the listing alone, so the size
// reported by stat() and the bytes returned by read() cannot disagree — which
// they would, silently truncating the file, if the server ever formatted its
// JSON a hair differently than we predicted.
//
// Pretty-printed with a trailing newline, HTML escaping off (a fit named
// "Rifter <cheap>" is a name, not markup), because this is a file people keep
// in a folder and diff, not a wire format.
func Render(f Fitting) []byte {
	items := f.Items
	if items == nil {
		items = []Item{}
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	// Only an unencodable value can fail here, and every field is a string or
	// an int64.
	_ = encoder.Encode(archiveFitting{
		FittingID:   f.FittingID,
		Name:        f.Name,
		Description: f.Description,
		ShipTypeID:  f.ShipTypeID,
		Items:       items,
	})
	return buf.Bytes()
}

// MarshalledDirName is the top-level folder holding the account's marshalled
// fits (docs/fitting-marshal.md): fits that are ours but in no game client.
// It takes the name before any character does, so a pilot called
// "Marshalled" mounts as "Marshalled (2)".
const MarshalledDirName = "Marshalled"

// ContentHash is the server's identity for a fit's content — the handle a
// marshalled fit is addressed by — computed the way src/fittingArchive.ts
// computes it: sha256 over the JSON of [ship_type_id, name, description,
// items] with the items normalized (sorted by "flag:type_id" as a string, the
// same key the extract and the server sort on) and reduced to
// [type_id, flag, quantity] rows. HTML escaping is off, as JSON.stringify's
// is. The one known divergence is U+2028/U+2029 in a name, which Go always
// escapes and JavaScript never does; the server answers such a PUT with the
// hash it computed, and PutMarshalled retries there, so the mismatch costs a
// round trip and never a wrong file. Pinned against the server's own vectors
// in marshal_test.go.
func ContentHash(f Fitting) string {
	items := normalizedItems(f.Items)
	rows := make([][]any, 0, len(items))
	for _, item := range items {
		rows = append(rows, []any{item.TypeID, item.Flag, item.Quantity})
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode([]any{f.ShipTypeID, f.Name, f.Description, rows})
	sum := sha256.Sum256(bytes.TrimSuffix(buf.Bytes(), []byte("\n")))
	return hex.EncodeToString(sum[:])
}

func normalizedItems(items []Item) []Item {
	out := append([]Item(nil), items...)
	for i := range out {
		if out[i].Quantity == 0 {
			out[i].Quantity = 1
		}
	}
	key := func(i Item) string { return i.Flag + ":" + strconv.FormatInt(i.TypeID, 10) }
	sort.SliceStable(out, func(a, b int) bool { return key(out[a]) < key(out[b]) })
	return out
}

// ParseFile reads an archive file the way the server's parseArchiveFitting
// does, far enough to compute its hash: the four content fields, unknown keys
// ignored, the name trimmed (the server trims it before hashing, so a file with
// a padded name hashes to the trimmed form on both sides). Validation proper
// stays on the server — this only has to agree with it on the handle.
func ParseFile(file []byte) (Fitting, error) {
	var parsed struct {
		FittingID   int64  `json:"fitting_id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		ShipTypeID  int64  `json:"ship_type_id"`
		Items       []Item `json:"items"`
	}
	if err := json.Unmarshal(file, &parsed); err != nil {
		return Fitting{}, fmt.Errorf("not a fitting file: %w", err)
	}
	return Fitting{
		FittingID:   parsed.FittingID,
		Name:        strings.TrimSpace(parsed.Name),
		Description: parsed.Description,
		ShipTypeID:  parsed.ShipTypeID,
		Items:       parsed.Items,
	}, nil
}
