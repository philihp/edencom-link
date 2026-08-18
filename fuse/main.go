// eve-fittings-fs mounts an EVE character's saved ship fittings as a folder.
//
// EVE caps a character at 500 saved fittings, which for anyone who flies more
// than one doctrine is a budget rather than a limit. The way out is to keep the
// ones you're flying in the game and the rest somewhere else — but "somewhere
// else" has always meant a third-party tool with its own list, its own accounts
// and its own idea of what a fitting is.
//
// This makes "somewhere else" a folder. The mount is the game's list; an
// archive is any directory on the disk; and moving a fit between them is `cp`
// and `rm`. Nothing new to learn, and the archived file is CCP's own JSON, so
// it outlives this program.
//
// The mount holds no EVE credentials. Every request goes to an edencom-link
// deployment carrying one revocable api_token, and that deployment is what
// holds the ESI grant, refreshes it, checks the 500-slot cap, and writes a copy
// of every fitting to its audit log before deleting anything. See
// docs/fitting-fuse.md.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/winfsp/cgofuse/fuse"

	"github.com/philihp/edencom-link/fuse/internal/link"
)

const usage = `eve-fittings-fs — browse and archive EVE ship fittings as files

  eve-fittings-fs [flags] <mountpoint>

The mountpoint is an empty directory; ~/EVE/Fittings is a fine choice. Each
linked character becomes a folder inside it, holding one JSON file per fitting
they have saved in game.

  cp  "$M/Philihp/Rifter - Tackle.json" ~/eve-archive/   archive a copy
  rm  "$M/Philihp/Rifter - Tackle.json"                  free the in-game slot
  cp  ~/eve-archive/"Rifter - Tackle.json" "$M/Philihp/" put it back later
  df  "$M"                                               slots left in game

Credentials come from the environment, so they stay out of shell history:

  EDENCOM_URL     deployment to talk to (default https://edencom.link)
  EDENCOM_TOKEN   the API token from /account/settings

Flags:
`

func main() {
	log.SetFlags(log.Ltime)
	log.SetPrefix("eve-fittings-fs: ")

	baseURL := flag.String("url", envOr("EDENCOM_URL", "https://edencom.link"), "edencom-link deployment")
	token := flag.String("token", os.Getenv("EDENCOM_TOKEN"), "API token (prefer $EDENCOM_TOKEN)")
	ttl := flag.Duration("ttl", 30*time.Second, "how long a directory listing is reused before refetching")
	readOnly := flag.Bool("readonly", false, "refuse every delete and restore, whatever the EVE grant allows")
	volname := flag.String("volname", "EVE Fittings", "volume name shown in Finder (macOS)")
	debug := flag.Bool("debug", false, "log every FUSE call")
	flag.Usage = func() {
		fmt.Fprint(flag.CommandLine.Output(), usage)
		flag.PrintDefaults()
	}
	flag.Parse()

	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(2)
	}
	mountpoint := flag.Arg(0)

	if strings.TrimSpace(*token) == "" {
		log.Fatal("no API token. Set EDENCOM_TOKEN to the token from /account/settings, or pass -token.")
	}
	if info, err := os.Stat(mountpoint); err != nil || !info.IsDir() {
		log.Fatalf("mountpoint %q is not a directory. Create it first: mkdir -p %q", mountpoint, mountpoint)
	}

	client := link.New(*baseURL, *token)
	filesystem := newFS(client, *ttl, *readOnly)

	// Fetch once before mounting. A bad token or an unreachable deployment
	// should be a message in the terminal, not a folder that appears in Finder
	// and then errors on every click.
	characters, err := client.List(filesystem.requests)
	if err != nil {
		log.Fatalf("could not reach %s: %v", *baseURL, err)
	}
	fittings := 0
	writable := 0
	for _, character := range characters {
		fittings += len(character.Fittings)
		if character.Writable {
			writable++
		}
	}
	log.Printf("%d character(s), %d fitting(s); %d may be written to", len(characters), fittings, writable)
	if writable == 0 && !*readOnly {
		log.Print("no character has granted permission to save and delete fittings — the mount will be browsable but archiving will fail. Enable it under ESI Access in settings, then re-add the character.")
	}

	host := fuse.NewFileSystemHost(filesystem)
	host.SetCapReaddirPlus(true)

	// Unmount on Ctrl-C, so an interrupted session doesn't leave a dead mount
	// that has to be cleared with `umount -f` before the next one will attach.
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-interrupts
		log.Print("unmounting")
		host.Unmount()
	}()

	log.Printf("mounted at %s", mountpoint)
	if !host.Mount(mountpoint, mountOptions(*volname, *debug)) {
		log.Fatal("mount failed. On macOS this usually means macFUSE is not installed (brew install --cask macfuse) or the mountpoint is busy.")
	}
}

// mountOptions are the flags handed to libfuse, which differ by platform in the
// ways that matter for a synthetic filesystem.
func mountOptions(volname string, debug bool) []string {
	options := []string{}
	if debug {
		options = append(options, "-d")
	}
	if runtime.GOOS == "darwin" {
		options = append(options,
			// Finder shows it as a local disk with a real name rather than an
			// unnamed network share.
			"-o", "volname="+volname,
			"-o", "local",
			// Stops Finder writing ._ resource forks and .DS_Store into a
			// filesystem where every created file is POSTed at CCP. Create()
			// refuses dotfiles as well; this keeps them from being attempted.
			"-o", "noappledouble",
			"-o", "noapplexattr",
			// Spotlight has no business indexing 500 fittings, and its crawl
			// would be 500 opens on every mount.
			"-o", "nobrowse",
		)
	}
	return options
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
