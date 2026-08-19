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
	"encoding/json"
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
