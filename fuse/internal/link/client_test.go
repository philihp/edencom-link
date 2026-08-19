package link

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func serve(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return New(server.URL, "test-token")
}

func TestListParsesACharacterAndItsFittings(t *testing.T) {
	client := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("X-Edencom-Source"); got != "fuse" {
			t.Errorf("X-Edencom-Source = %q — the audit trail cannot tell where a delete came from", got)
		}
		io.WriteString(w, `{"characters":[{
			"character_id":"90000001","name":"Philihp","writable":true,
			"data_refreshed":"2026-08-18T12:00:00Z",
			"fittings":[{"fitting_id":7,"name":"Tackle","description":"cheap",
				"ship_type_id":587,"ship_name":"Rifter",
				"items":[{"type_id":2048,"flag":"LoSlot0","quantity":1}],
				"modified":"2026-08-01T00:00:00Z"}]}]}`)
	})

	characters, err := client.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(characters) != 1 || len(characters[0].Fittings) != 1 {
		t.Fatalf("got %+v", characters)
	}
	character := characters[0]
	if character.CharacterID != "90000001" || character.Name != "Philihp" || !character.Writable {
		t.Errorf("character = %+v", character)
	}
	if character.Refreshed.IsZero() {
		t.Error("data_refreshed did not parse")
	}
	fit := character.Fittings[0]
	if fit.FittingID != 7 || fit.ShipTypeID != 587 || fit.ShipName != "Rifter" || len(fit.Items) != 1 {
		t.Errorf("fitting = %+v", fit)
	}
}

func TestListToleratesAMissingRefreshTimestamp(t *testing.T) {
	// A character whose fittings have never been extracted has no heartbeat, so
	// the field comes back null. That is a new character, not a broken mount.
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"characters":[{"character_id":"1","name":"New","data_refreshed":null,"fittings":[]}]}`)
	})
	characters, err := client.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(characters) != 1 || !characters[0].Refreshed.IsZero() {
		t.Fatalf("got %+v", characters)
	}
}

func TestArchiveSendsADeleteForTheRightFitting(t *testing.T) {
	var method, path string
	client := serve(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		io.WriteString(w, `{"archived":{}}`)
	})
	if err := client.Archive(context.Background(), "90000001", 7); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodDelete || path != "/api/fittings/90000001/7" {
		t.Errorf("%s %s", method, path)
	}
}

func TestRestorePutsTheFileVerbatimToAMintedKey(t *testing.T) {
	// The bytes off the player's disk go up untouched: the server is what
	// decides whether they are a fitting, so this client can never be the thing
	// that is out of date about ESI's rules.
	file := []byte(`{"name":"Tackle","ship_type_id":587,"items":[]}`)
	var received []byte
	var method, path string
	client := serve(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		received, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{"fitting_id": 42, "created": true})
	})

	restored, err := client.Restore(context.Background(), "90000001", file)
	if err != nil {
		t.Fatal(err)
	}
	if string(received) != string(file) {
		t.Errorf("body was rewritten: %q", string(received))
	}
	if method != http.MethodPut {
		t.Errorf("method = %s, want PUT", method)
	}
	// A restore is addressed by a uuid the client mints, never by a fitting id:
	// EVE assigns that itself, so there is nothing else to name.
	prefix := "/api/fittings/90000001/"
	if !strings.HasPrefix(path, prefix) || !uuidV4.MatchString(strings.TrimPrefix(path, prefix)) {
		t.Errorf("path = %q, want %s<uuid>", path, prefix)
	}
	if restored.FittingID != 42 || !restored.Created {
		t.Errorf("restored = %+v", restored)
	}
}

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestRequestIDIsAFreshV4Uuid(t *testing.T) {
	// Uniqueness is the only property the key needs — it is never shown to CCP
	// and never becomes the fitting's identity — but it has to actually be
	// unique, and it has to be a uuid the server's route will accept.
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id, err := RequestID()
		if err != nil {
			t.Fatal(err)
		}
		if !uuidV4.MatchString(id) {
			t.Fatalf("RequestID() = %q, not a v4 uuid", id)
		}
		if seen[id] {
			t.Fatalf("RequestID() repeated %q", id)
		}
		seen[id] = true
	}
}

func TestEachRestoreGetsItsOwnKey(t *testing.T) {
	// Two copies of the same file are two attempts, not one retried. They must
	// not share a key — a reused key is a 409, so a shared one would turn the
	// second, perfectly legitimate copy into a failure.
	paths := []string{}
	client := serve(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		io.WriteString(w, `{"fitting_id":1,"created":true}`)
	})
	for i := 0; i < 2; i++ {
		if _, err := client.Restore(context.Background(), "1", []byte(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	if paths[0] == paths[1] {
		t.Errorf("both restores used %q", paths[0])
	}
}

func TestRestoreReportsAFitTheGameAlreadyHad(t *testing.T) {
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"fitting_id":9,"created":false}`)
	})
	restored, err := client.Restore(context.Background(), "1", []byte(`{}`))
	if err != nil || restored.Created || restored.FittingID != 9 {
		t.Fatalf("restored = %+v, err = %v", restored, err)
	}
}

func TestARefusalCarriesItsStatusAndSentence(t *testing.T) {
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInsufficientStorage)
		io.WriteString(w, `{"error":"Philihp already has 500 of 500 fittings saved in EVE."}`)
	})
	_, err := client.Restore(context.Background(), "1", []byte(`{}`))
	if err == nil {
		t.Fatal("expected a refusal")
	}
	if StatusOf(err) != http.StatusInsufficientStorage {
		t.Errorf("status = %d", StatusOf(err))
	}
	if err.Error() != "Philihp already has 500 of 500 fittings saved in EVE." {
		t.Errorf("message = %q", err.Error())
	}
}

func TestAReusedRestoreKeyIsAConflict(t *testing.T) {
	// A restore key is used once. The client mints a fresh one per attempt, so
	// this is a collision rather than a retry — it has to surface as a refusal
	// with its status intact, since that is what fs.go turns into EEXIST.
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		io.WriteString(w, `{"error":"Request id … has already been used. Mint a new one.","fitting_id":9}`)
	})
	_, err := client.Restore(context.Background(), "1", []byte(`{}`))
	if err == nil {
		t.Fatal("a reused key should not look like a successful restore")
	}
	if StatusOf(err) != http.StatusConflict {
		t.Errorf("status = %d, want 409", StatusOf(err))
	}
}

func TestANonJsonFailureFallsBackToTheStatusLine(t *testing.T) {
	// A proxy or a cold deployment answers HTML; showing the player a page of
	// markup instead of "502 Bad Gateway" helps nobody.
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		io.WriteString(w, "<html>gateway</html>")
	})
	_, err := client.List(context.Background())
	if err == nil || err.Error() != "502 Bad Gateway" {
		t.Fatalf("err = %v", err)
	}
	if StatusOf(err) != http.StatusBadGateway {
		t.Errorf("status = %d", StatusOf(err))
	}
}

func TestStatusOfIgnoresErrorsThatAreNotRefusals(t *testing.T) {
	client := New("http://127.0.0.1:1", "t")
	_, err := client.List(context.Background())
	if err == nil {
		t.Fatal("expected a connection failure")
	}
	if StatusOf(err) != 0 {
		t.Errorf("a transport failure should carry no HTTP status, got %d", StatusOf(err))
	}
}
