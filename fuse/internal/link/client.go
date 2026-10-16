// Package link is the client for edencom-link's /api/fittings endpoints.
//
// Everything this filesystem knows comes through here, and that is the point of
// the design: the daemon on the laptop holds one revocable api_token and no EVE
// credentials at all. Token refresh, the ESI error budget, the 500-slot guard,
// the write-ahead audit log and the archive's own idea of what a fitting is all
// live on the server, where they are deployed, monitored and fixed once — not
// in a binary someone downloaded in March.
package link

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/philihp/edencom-link/fuse/internal/vfs"
)

// Client talks to one edencom-link deployment as one account.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// New builds a client against a deployment. The timeout is generous because the
// two write calls are synchronous all the way through to CCP — a delete is a
// listing fetch, a database write and an ESI round trip before it answers.
func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimSuffix(baseURL, "/"),
		Token:   token,
		HTTP:    &http.Client{Timeout: 60 * time.Second},
	}
}

// Error is a refusal from the API, carrying the sentence it wants shown. The
// status is what decides which errno the filesystem reports, so the message
// reaches a shell as more than "Operation not permitted".
type Error struct {
	Status  int
	Message string
	// The response body, for the one refusal that carries an answer: a PUT to
	// the wrong content hash says which hash the body really has.
	Payload []byte
}

func (e *Error) Error() string { return e.Message }

// StatusOf digs the HTTP status out of an error, or 0 if it wasn't one of ours.
func StatusOf(err error) int {
	var apiError *Error
	if errors.As(err, &apiError) {
		return apiError.Status
	}
	return 0
}

func (c *Client) do(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Accept", "application/json")
	// Tags every row this daemon writes to fitting_write_log, so the audit trail
	// distinguishes a fit archived by dragging it out of a Finder window from
	// one archived by a curl.
	request.Header.Set("X-Edencom-Source", "fuse")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := c.HTTP.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 400 {
		return nil, &Error{Status: response.StatusCode, Message: messageFrom(payload, response.Status), Payload: payload}
	}
	return payload, nil
}

// The server answers every refusal as {"error": "..."}, written for a person.
// Anything else (a proxy's HTML, an empty body) falls back to the status line
// rather than showing the user a page of markup.
func messageFrom(payload []byte, status string) string {
	var parsed struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(payload, &parsed); err == nil && parsed.Error != "" {
		return parsed.Error
	}
	return strings.TrimSpace(status)
}

type listedFitting struct {
	FittingID   int64      `json:"fitting_id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	ShipTypeID  int64      `json:"ship_type_id"`
	ShipName    string     `json:"ship_name"`
	Items       []vfs.Item `json:"items"`
	Modified    string     `json:"modified"`
	ContentHash string     `json:"content_hash"`
}

type listing struct {
	// The account's marshalled fits (docs/fitting-marshal.md), beside the
	// characters so one response builds the whole tree.
	Marshalled []listedFitting `json:"marshalled"`
	Characters []struct {
		CharacterID string          `json:"character_id"`
		Name        string          `json:"name"`
		Writable    bool            `json:"writable"`
		Refreshed   string          `json:"data_refreshed"`
		Fittings    []listedFitting `json:"fittings"`
	} `json:"characters"`
}

// A timestamp the API may legitimately omit (a character whose fittings have
// never been extracted has no heartbeat to report). Unparseable reads as zero,
// which the filesystem shows as the epoch rather than refusing to mount.
func timestamp(raw string) time.Time {
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func toFitting(fit listedFitting) vfs.Fitting {
	return vfs.Fitting{
		FittingID:   fit.FittingID,
		Name:        fit.Name,
		Description: fit.Description,
		ShipTypeID:  fit.ShipTypeID,
		ShipName:    fit.ShipName,
		Items:       fit.Items,
		Modified:    timestamp(fit.Modified),
		ContentHash: fit.ContentHash,
	}
}

// List fetches every character and every fitting, and the account's
// marshalled fits, in one request.
func (c *Client) List(ctx context.Context) ([]vfs.Character, []vfs.Fitting, error) {
	payload, err := c.do(ctx, http.MethodGet, "/api/fittings", nil)
	if err != nil {
		return nil, nil, err
	}
	var parsed listing
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil, nil, fmt.Errorf("unreadable listing: %w", err)
	}
	marshalled := make([]vfs.Fitting, 0, len(parsed.Marshalled))
	for _, fit := range parsed.Marshalled {
		marshalled = append(marshalled, toFitting(fit))
	}

	characters := make([]vfs.Character, 0, len(parsed.Characters))
	for _, raw := range parsed.Characters {
		character := vfs.Character{
			CharacterID: raw.CharacterID,
			Name:        raw.Name,
			Writable:    raw.Writable,
			Refreshed:   timestamp(raw.Refreshed),
		}
		for _, fit := range raw.Fittings {
			character.Fittings = append(character.Fittings, toFitting(fit))
		}
		characters = append(characters, character)
	}
	return characters, marshalled, nil
}

// Archive deletes one fitting from the game, after the server has stored it.
func (c *Client) Archive(ctx context.Context, characterID string, fittingID int64) error {
	_, err := c.do(ctx, http.MethodDelete, fmt.Sprintf("/api/fittings/%s/%d", url.PathEscape(characterID), fittingID), nil)
	return err
}

// Restored reports what a restore did: the game id the fit now has, and whether
// EVE actually gained a fit or already had this exact one saved.
type Restored struct {
	FittingID int64 `json:"fitting_id"`
	Created   bool  `json:"created"`
}

// RequestID mints the key a restore is addressed by: a random (version 4) uuid.
//
// Hand-rolled rather than pulled from a dependency, because this is the only
// uuid in the program and 12 lines of crypto/rand beats a module. Nothing reads
// the bits — the key only has to be unique, and 122 random ones are.
func RequestID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("no randomness for a request id: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// Restore replays an archive file back into the character's in-game library,
// as a PUT to a key this client mints.
//
// The key is what makes the write idempotent: the fitting does not exist yet
// and CCP will assign its id, so there is no server-side name to address, but
// a uuid names the attempt. Retry after a lost response and the same PUT lands
// on the same row and reports the fitting EVE already saved, instead of saving
// a second copy.
//
// The body is the file's bytes, unexamined — the server validates it, because
// the server is where a "which fields does ESI accept" answer stays current.
func (c *Client) Restore(ctx context.Context, characterID string, file []byte) (Restored, error) {
	requestID, err := RequestID()
	if err != nil {
		return Restored{}, err
	}
	path := fmt.Sprintf("/api/fittings/%s/%s", url.PathEscape(characterID), requestID)
	payload, err := c.do(ctx, http.MethodPut, path, file)
	if err != nil {
		return Restored{}, err
	}
	var restored Restored
	if err := json.Unmarshal(payload, &restored); err != nil {
		return Restored{}, fmt.Errorf("unreadable response: %w", err)
	}
	return restored, nil
}

// ── the marshalled archive (docs/fitting-marshal.md) ─────────────────────

// Marshal deletes one fitting from the game AND keeps it in the account's
// archive, in one server-side step so the copy stored is the one ESI handed
// back at the moment of the delete. Answers the archive handle.
func (c *Client) Marshal(ctx context.Context, characterID string, fittingID int64) (string, error) {
	path := fmt.Sprintf("/api/fittings/%s/%d?marshal=1", url.PathEscape(characterID), fittingID)
	payload, err := c.do(ctx, http.MethodDelete, path, nil)
	if err != nil {
		return "", err
	}
	var answer struct {
		ContentHash string `json:"content_hash"`
	}
	if err := json.Unmarshal(payload, &answer); err != nil || answer.ContentHash == "" {
		return "", fmt.Errorf("unreadable response: marshal answered no content hash")
	}
	return answer.ContentHash, nil
}

// Stored reports what a PUT into the archive did.
type Stored struct {
	ContentHash string `json:"content_hash"`
	Created     bool   `json:"created"`
}

// PutMarshalled stores an archive file in the account's archive without
// touching the game, at the file's own content hash.
//
// The hash is computed here (vfs.ContentHash) so the PUT is one round trip;
// but the server is the authority on it, and refuses a PUT whose path is not
// the body's hash with the hash it computed. That refusal is followed once —
// it covers the one encoding the two sides spell differently — so a file
// always lands at the address the server will later answer to.
func (c *Client) PutMarshalled(ctx context.Context, file []byte) (Stored, error) {
	fit, err := vfs.ParseFile(file)
	if err != nil {
		return Stored{}, &Error{Status: 400, Message: err.Error()}
	}
	stored, err := c.putMarshalledAt(ctx, vfs.ContentHash(fit), file)
	if err == nil {
		return stored, nil
	}
	var refusal *Error
	if errors.As(err, &refusal) && refusal.Status == 400 {
		var answer struct {
			ContentHash string `json:"content_hash"`
		}
		if json.Unmarshal(refusal.Payload, &answer) == nil && answer.ContentHash != "" {
			return c.putMarshalledAt(ctx, answer.ContentHash, file)
		}
	}
	return Stored{}, err
}

func (c *Client) putMarshalledAt(ctx context.Context, hash string, file []byte) (Stored, error) {
	payload, err := c.do(ctx, http.MethodPut, "/api/fittings/marshalled/"+url.PathEscape(hash), file)
	if err != nil {
		return Stored{}, err
	}
	var stored Stored
	if err := json.Unmarshal(payload, &stored); err != nil {
		return Stored{}, fmt.Errorf("unreadable response: %w", err)
	}
	return stored, nil
}

// DeleteMarshalled removes one fit from the archive. Permanent; no ESI call.
func (c *Client) DeleteMarshalled(ctx context.Context, hash string) error {
	_, err := c.do(ctx, http.MethodDelete, "/api/fittings/marshalled/"+url.PathEscape(hash), nil)
	return err
}
