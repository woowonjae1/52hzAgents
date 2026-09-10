// Package webui carries the exported Next.js frontend inside the server
// binary, so a release is one file rather than an executable plus a `public/`
// directory that has to travel with it and stay in sync.
//
// The server already served the frontend before this — `main.go` walked a list
// of candidate paths (`./public`, `../frontend/out`, …) and answered from disk.
// That works, but it means the binary is not the artifact: ship it alone and it
// starts, serves the API, and returns nothing for every page. Embedding makes
// "the frontend that goes with this server" a property of the build instead of
// a property of the directory someone happened to run it from.
//
// Disk lookup is deliberately kept as a fallback in `main.go`. During frontend
// development the embedded copy is whatever was baked at compile time, and
// rebuilding Go on every CSS change is not a workflow — so a real `out/` on
// disk still wins when one is present.
package webui

import (
	"embed"
	"io/fs"
)

/*
`all:` IS LOAD-BEARING, NOT DECORATION.

A plain `//go:embed dist` silently skips every file and directory whose name
begins with `_` or `.` — and Next.js puts ITS ENTIRE JS AND CSS BUNDLE in
`_next/`. Without the prefix this compiles, embeds the HTML, serves a page that
references `/_next/static/chunks/…`, and every one of those 404s: a white
screen from a build that reported success. `all:` is what includes them.

`dist/` is generated (the build script copies `frontend/out` into it) and is
therefore gitignored — but `//go:embed` is resolved by the COMPILER, and a
pattern that matches no files is a build error, not an empty FS. So the
directory ships with a `.gitkeep` placeholder to keep `go build` working on a
clean checkout where nobody has built the frontend yet. `Enabled` below is how
callers tell that placeholder apart from a real export.
*/
//go:embed all:dist
var dist embed.FS

// FS returns the embedded export rooted at `dist/`, and whether it holds a real
// frontend rather than just the placeholder that keeps the compiler happy.
//
// The test is `index.html`: a Next.js export always produces one, and the
// placeholder-only tree never does. Reporting `false` lets `main.go` fall
// through to its disk paths instead of serving an empty directory, which would
// otherwise turn "nobody built the frontend" into a 404 on every page with no
// hint as to why.
func FS() (fs.FS, bool) {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil, false
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil, false
	}
	return sub, true
}
