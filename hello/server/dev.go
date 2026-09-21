//go:build dev

// `go run -tags dev ./server` serves the same handlers on TCP so
// `plum-dev serve --service http://127.0.0.1:8080` can reach them on a laptop.
package main
