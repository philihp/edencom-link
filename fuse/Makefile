# eve-fittings-fs — the macOS FUSE client for the fittings archive.
#
# `make` builds the binary for whatever machine you are on. On macOS that needs
# macFUSE's headers, which come with the cask:
#
#     brew install --cask macfuse
#
# There is no cross-compile target, and there cannot usefully be one: the
# filesystem layer binds to libfuse through cgo, so a macOS binary has to be
# built on macOS. Everything above that layer is plain Go and is what `make
# test` covers, which is why the CI job on Linux is worth anything.

BINARY := eve-fittings-fs
PREFIX ?= /usr/local

.PHONY: all build test vet fmt install clean

all: build

build:
	go build -o $(BINARY) .

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

install: build
	install -d $(PREFIX)/bin
	install -m 0755 $(BINARY) $(PREFIX)/bin/$(BINARY)

clean:
	rm -f $(BINARY)
