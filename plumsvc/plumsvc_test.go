package plumsvc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// fakeCore serves a control socket the way core does, recording requests.
func fakeCore(t *testing.T) (*Client, *http.ServeMux) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "ctl.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return NewWithSocket(sock), mux
}

func TestClientCalls(t *testing.T) {
	c, mux := fakeCore(t)
	var published map[string]string
	mux.HandleFunc("/files/publish", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&published)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/files/list", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("root") != "files" || r.URL.Query().Get("path") != "docs" {
			w.WriteHeader(400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"entries": []Entry{{Name: "a.txt", Path: "docs/a.txt", Size: 5}}})
	})
	mux.HandleFunc("/files/read", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("hello")) })
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(Profile{ID: "u1", Username: "alice", Locale: "ko"})
	})
	mux.HandleFunc("/notify", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "app lacks files:write permission"})
	})
	mux.HandleFunc("/entitlement", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNotImplemented) })

	ctx := context.Background()
	if err := c.PublishContext(ctx, Downloads, "done.bin", "sub/done.bin"); err != nil {
		t.Fatal(err)
	}
	if published["root"] != "downloads" || published["src"] != "done.bin" || published["dest"] != "sub/done.bin" {
		t.Fatalf("publish body %v", published)
	}
	entries, err := c.Files(ctx, Files, "docs")
	if err != nil || len(entries) != 1 || entries[0].Path != "docs/a.txt" {
		t.Fatalf("files: %v %v", entries, err)
	}
	rc, err := c.Read(ctx, Files, "docs/a.txt")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(rc)
	rc.Close()
	if string(b) != "hello" {
		t.Fatalf("read %q", b)
	}
	p, err := c.User(ctx)
	if err != nil || p.Username != "alice" {
		t.Fatalf("user: %v %v", p, err)
	}
	var e *Error
	if err := c.Notify(ctx, "done", "t", ""); !errors.As(err, &e) || e.Status != 403 {
		t.Fatalf("notify error mapping: %v", err)
	}
	if _, err := c.Entitlements(ctx); !errors.Is(err, ErrNotImplemented) {
		t.Fatalf("entitlement 501 mapping: %v", err)
	}
}

func TestCallerOf(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set(HeaderUserID, "u1")
	r.Header.Set(HeaderUsername, "alice")
	r.Header.Set(HeaderAppID, "dev.a.x")
	r.Header.Set(HeaderPerms, `["files:read","service:call"]`)
	c := CallerOf(r)
	if c.UserID != "u1" || c.AppID != "dev.a.x" || !c.Has("files:read") || c.Has("files:write") {
		t.Fatalf("caller %+v", c)
	}
}

func TestNewRequiresSupervisor(t *testing.T) {
	t.Setenv("PLUM_CTL_SOCKET", "")
	if _, err := New(); err == nil {
		t.Fatal("New without PLUM_CTL_SOCKET should fail")
	}
}
