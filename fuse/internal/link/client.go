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
		return nil, &Error{Status: response.StatusCode, Message: messageFrom(payload, response.Status)}
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

type listing struct {
	Characters []struct {
		CharacterID string `json:"character_id"`
		Name        string `json:"name"`
		Writable    bool   `json:"writable"`
		Refreshed   string `json:"data_refreshed"`
		Fittings    []struct {
			FittingID   int64      `json:"fitting_id"`
			Name        string     `json:"name"`
			Description string     `json:"description"`
			ShipTypeID  int64      `json:"ship_type_id"`
			ShipName    string     `json:"ship_name"`
			Items       []vfs.Item `json:"items"`
			Modified    string     `json:"modified"`
		} `json:"fittings"`
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

// List fetches every character and every fitting in one request.
func (c *Client) List(ctx context.Context) ([]vfs.Character, error) {
	payload, err := c.do(ctx, http.MethodGet, "/api/fittings", nil)
	if err != nil {
		return nil, err
	}
	var parsed listing
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil, fmt.Errorf("unreadable listing: %w", err)
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
			character.Fittings = append(character.Fittings, vfs.Fitting{
				FittingID:   fit.FittingID,
				Name:        fit.Name,
				Description: fit.Description,
				ShipTypeID:  fit.ShipTypeID,
				ShipName:    fit.ShipName,
				Items:       fit.Items,
				Modified:    timestamp(fit.Modified),
			})
		}
		characters = append(characters, character)
	}
	return characters, nil
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

// Restore replays an archive file back into the character's in-game library.
// The body is the file's bytes, unexamined — the server validates it, because
// the server is where a "which fields does ESI accept" answer stays current.
func (c *Client) Restore(ctx context.Context, characterID string, file []byte) (Restored, error) {
	payload, err := c.do(ctx, http.MethodPost, "/api/fittings/"+url.PathEscape(characterID), file)
	if err != nil {
		return Restored{}, err
	}
	var restored Restored
	if err := json.Unmarshal(payload, &restored); err != nil {
		return Restored{}, fmt.Errorf("unreadable response: %w", err)
	}
	return restored, nil
}
