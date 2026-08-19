package main

import (
	"errors"
	"testing"

	"github.com/winfsp/cgofuse/fuse"

	"github.com/philihp/edencom-link/fuse/internal/link"
)

// A filesystem can only say a number, so the number has to be the one that
// misleads least — it is the whole error message a `cp` or an `rm` will print.
func TestApiRefusalsBecomeTheRightErrno(t *testing.T) {
	cases := map[int]int{
		401: -fuse.EACCES, // no/!valid api token
		403: -fuse.EACCES, // the character has not granted the write scope
		400: -fuse.EINVAL, // the file is not a fitting
		404: -fuse.ENOENT, // EVE has no such fitting
		409: -fuse.EEXIST, // the restore key has already been used
		507: -fuse.ENOSPC, // all 500 in-game slots are full
		500: -fuse.EIO,
		502: -fuse.EIO,
	}
	for status, want := range cases {
		got := errnoFor(&link.Error{Status: status, Message: "nope"})
		if got != want {
			t.Errorf("status %d → errno %d, want %d", status, got, want)
		}
	}
}

func TestATransportFailureIsAnIOError(t *testing.T) {
	// No HTTP status at all: the deployment was unreachable, DNS failed, the
	// laptop slept. Nothing more specific than EIO is honest.
	if got := errnoFor(errors.New("dial tcp: no route to host")); got != -fuse.EIO {
		t.Errorf("errno %d, want %d", got, -fuse.EIO)
	}
}
