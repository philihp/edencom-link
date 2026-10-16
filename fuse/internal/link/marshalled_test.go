package link

import (
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/philihp/edencom-link/fuse/internal/vfs"
)

const caneHash = "4751594f6327405a8f253ca6866f6b82640e96a691c7588a58e0b4c2ccf2bf5b"

var caneFile = []byte(`{"fitting_id": 12, "name": "Doctrine Cane", "description": "", "ship_type_id": 24702, "items": []}`)

func TestListCarriesTheMarshalledFits(t *testing.T) {
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"characters":[],"marshalled":[{"content_hash":"`+caneHash+`","fitting_id":12,
			"name":"Doctrine Cane","description":"","ship_type_id":24702,"ship_name":"Hurricane",
			"items":[],"marshalled_at":"2026-10-16T00:00:00Z","modified":"2026-10-16T00:00:00Z",
			"source":"web","source_character_id":"90000001"}]}`)
	})
	characters, marshalled, err := client.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(characters) != 0 || len(marshalled) != 1 {
		t.Fatalf("characters = %+v, marshalled = %+v", characters, marshalled)
	}
	fit := marshalled[0]
	if fit.ContentHash != caneHash || fit.FittingID != 12 || fit.ShipName != "Hurricane" || fit.Modified.IsZero() {
		t.Errorf("marshalled fit = %+v", fit)
	}
}

func TestListToleratesAListingWithoutAMarshalledArray(t *testing.T) {
	// A deployment that predates the archive answers the old shape.
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"characters":[]}`)
	})
	_, marshalled, err := client.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(marshalled) != 0 {
		t.Fatalf("got %+v", marshalled)
	}
}

func TestMarshalIsTheDeleteWithTheFlag(t *testing.T) {
	var method, path, query string
	client := serve(t, func(w http.ResponseWriter, r *http.Request) {
		method, path, query = r.Method, r.URL.Path, r.URL.RawQuery
		io.WriteString(w, `{"archived":{},"content_hash":"`+caneHash+`"}`)
	})
	hash, err := client.Marshal(context.Background(), "90000001", 7)
	if err != nil {
		t.Fatal(err)
	}
	if method != http.MethodDelete || path != "/api/fittings/90000001/7" || query != "marshal=1" {
		t.Errorf("%s %s?%s", method, path, query)
	}
	if hash != caneHash {
		t.Errorf("hash = %s", hash)
	}
}

func TestMarshalWithoutAHashInTheAnswerIsAnError(t *testing.T) {
	// A plain archive-delete answer (no content_hash) means the server did not
	// store the fit; the client must not report a marshal that did not happen.
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"archived":{}}`)
	})
	if _, err := client.Marshal(context.Background(), "90000001", 7); err == nil {
		t.Error("a marshal with no hash answered succeeded")
	}
}

func TestPutMarshalledLandsAtTheFilesOwnHash(t *testing.T) {
	var method, path string
	var body []byte
	client := serve(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		body, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{"content_hash":"`+caneHash+`","created":true}`)
	})
	stored, err := client.PutMarshalled(context.Background(), caneFile)
	if err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPut || path != "/api/fittings/marshalled/"+caneHash {
		t.Errorf("%s %s", method, path)
	}
	if string(body) != string(caneFile) {
		t.Error("the file was not sent as-is")
	}
	if !stored.Created || stored.ContentHash != caneHash {
		t.Errorf("stored = %+v", stored)
	}
	// Belt and braces: the hash the client computed is the server's.
	fit, _ := vfs.ParseFile(caneFile)
	if vfs.ContentHash(fit) != caneHash {
		t.Error("client-side hash disagrees with the pinned server hash")
	}
}

func TestPutMarshalledFollowsTheServersHashOnce(t *testing.T) {
	// The one encoding the two sides spell differently gets a 400 carrying
	// the server's hash; the client retries there, once, and reports that.
	var paths []string
	serverHash := "ffff" + caneHash[4:]
	client := serve(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if len(paths) == 1 {
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":"The fitting hashes to `+serverHash+`","content_hash":"`+serverHash+`"}`)
			return
		}
		io.WriteString(w, `{"content_hash":"`+serverHash+`","created":false}`)
	})
	stored, err := client.PutMarshalled(context.Background(), caneFile)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 || paths[1] != "/api/fittings/marshalled/"+serverHash {
		t.Errorf("paths = %v", paths)
	}
	if stored.ContentHash != serverHash || stored.Created {
		t.Errorf("stored = %+v", stored)
	}
}

func TestPutMarshalledDoesNotLoopOnARefusalWithoutAHash(t *testing.T) {
	calls := 0
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":"Fitting has no name."}`)
	})
	_, err := client.PutMarshalled(context.Background(), caneFile)
	if err == nil || StatusOf(err) != 400 {
		t.Fatalf("err = %v", err)
	}
	if calls != 1 {
		t.Errorf("a plain 400 was retried %d times", calls)
	}
}

func TestPutMarshalledRefusesANonFittingBeforeTheNetwork(t *testing.T) {
	calls := 0
	client := serve(t, func(w http.ResponseWriter, _ *http.Request) { calls++ })
	_, err := client.PutMarshalled(context.Background(), []byte("not json"))
	if err == nil || StatusOf(err) != 400 || calls != 0 {
		t.Errorf("err = %v, calls = %d", err, calls)
	}
}

func TestDeleteMarshalledSendsADeleteForTheHash(t *testing.T) {
	var method, path string
	client := serve(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		io.WriteString(w, `{"deleted":true}`)
	})
	if err := client.DeleteMarshalled(context.Background(), caneHash); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodDelete || path != "/api/fittings/marshalled/"+caneHash {
		t.Errorf("%s %s", method, path)
	}
}
