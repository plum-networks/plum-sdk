// Package plumsvc is the server-side Plum SDK: the box-side counterpart of
// the browser's window.plum.* API. A "server .plu" — a Plum app that ships
// its own service — imports this to reach core through the per-app control
// socket the box provides (PLUM_CTL_SOCKET).
//
// Authorisation is by socket ownership: core creates the control socket for
// exactly one (user, app) and hands it to that app's own OS account, so
// there is no token to manage. Every call is scoped by core to the verified
// user and app and gated on the app's effective manifest permissions:
//
//	files:read     Files, Read
//	files:write    Publish
//	user:profile   User
//	(always)       Notify, Publish event, Entitlement, env helpers
//
// The service itself listens on the unix socket named by PLUM_APP_SOCKET
// (see ServeSocket); core proxies /apps/<id>/svc/* to it and injects
// X-Plum-User-Id, X-Plum-Username, X-Plum-App-Id and X-Plum-Perms on every
// request after stripping anything a caller sent under those names.
package plumsvc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Env helpers: what the supervisor injects into a service's environment.
func AppDataDir() string  { return os.Getenv("PLUM_APP_DATA_DIR") }
func UserID() string      { return os.Getenv("PLUM_USER_ID") }
func AppID() string       { return os.Getenv("PLUM_APP_ID") }
func AppVersion() string  { return os.Getenv("PLUM_APP_VERSION") }
func ServeSocket() string { return os.Getenv("PLUM_APP_SOCKET") }
func ControlSocket() string {
	return os.Getenv("PLUM_CTL_SOCKET")
}

// Identity headers core injects on proxied requests to the service.
const (
	HeaderUserID   = "X-Plum-User-Id"
	HeaderUsername = "X-Plum-Username"
	HeaderAppID    = "X-Plum-App-Id"
	HeaderPerms    = "X-Plum-Perms" // JSON array of effective permissions
	HeaderMount    = "X-Plum-Mount" // set on protocol mounts (/dav/<id>/)
)

// Caller reads the identity core attached to an incoming request.
type Caller struct {
	UserID   string
	Username string
	AppID    string
	Perms    []string
	Mount    string
}

// CallerOf parses the identity headers of a proxied request.
func CallerOf(r *http.Request) Caller {
	c := Caller{
		UserID:   r.Header.Get(HeaderUserID),
		Username: r.Header.Get(HeaderUsername),
		AppID:    r.Header.Get(HeaderAppID),
		Mount:    r.Header.Get(HeaderMount),
	}
	_ = json.Unmarshal([]byte(r.Header.Get(HeaderPerms)), &c.Perms)
	return c
}

// Has reports whether the caller's app holds perm (e.g. "files:write").
func (c Caller) Has(perm string) bool {
	for _, p := range c.Perms {
		if p == perm {
			return true
		}
	}
	return false
}

// Error is a control-plane refusal with the HTTP status core used.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("plumsvc: %d %s", e.Status, e.Message) }

// ErrNotImplemented is returned for capabilities this box does not have yet
// (an older core, or a feature that has not shipped).
var ErrNotImplemented = errors.New("plumsvc: not implemented by this box")

// Client talks to core over the control socket.
type Client struct {
	hc *http.Client
}

// New builds a Client from PLUM_CTL_SOCKET. It errors if the process wasn't
// launched by the Plum supervisor (the variable is unset).
func New() (*Client, error) {
	sock := ControlSocket()
	if sock == "" {
		return nil, errors.New("plumsvc: PLUM_CTL_SOCKET not set (not launched by the Plum supervisor)")
	}
	return NewWithSocket(sock), nil
}

// NewWithSocket builds a Client for an explicit socket path (tests, tools).
func NewWithSocket(sock string) *Client {
	return &Client{hc: &http.Client{
		Timeout: 60 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", sock)
			},
		},
	}}
}

// Root selects an area of the user's storage.
type Root string

const (
	Downloads Root = "downloads"
	Files     Root = "files"
)

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://plum"+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("plumsvc: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return errorFrom(resp)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func errorFrom(resp *http.Response) error {
	var e struct {
		Error string `json:"error"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = json.Unmarshal(raw, &e)
	if e.Error == "" {
		e.Error = strings.TrimSpace(string(raw))
	}
	if resp.StatusCode == http.StatusNotImplemented {
		return ErrNotImplemented
	}
	return &Error{Status: resp.StatusCode, Message: e.Error}
}

// Publish moves a file or directory the app produced in its OWN data dir
// (AppDataDir) into the user's storage. src is relative to the app data dir,
// dest to the chosen root. Same filesystem, so it is a rename: instant and
// safe for multi-gigabyte results. Requires files:write.
func (c *Client) Publish(root Root, src, dest string) error {
	return c.PublishContext(context.Background(), root, src, dest)
}

// PublishContext is Publish with a context.
func (c *Client) PublishContext(ctx context.Context, root Root, src, dest string) error {
	return c.do(ctx, http.MethodPost, "/files/publish", map[string]string{"root": string(root), "src": src, "dest": dest}, nil)
}

// Entry is one item of a directory listing in the user's storage.
type Entry struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"` // relative to the root
	IsDir    bool      `json:"is_dir"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

// Files lists a directory of the user's storage (files:read). Secret
// folders and hidden entries are never returned.
func (c *Client) Files(ctx context.Context, root Root, path string) ([]Entry, error) {
	var out struct {
		Entries []Entry `json:"entries"`
	}
	q := url.Values{"root": {string(root)}, "path": {path}}
	if err := c.do(ctx, http.MethodGet, "/files/list?"+q.Encode(), nil, &out); err != nil {
		return nil, err
	}
	return out.Entries, nil
}

// Read streams one file of the user's storage (files:read). The caller
// closes the reader.
func (c *Client) Read(ctx context.Context, root Root, path string) (io.ReadCloser, error) {
	q := url.Values{"root": {string(root)}, "path": {path}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://plum/files/read?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("plumsvc: %w", err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, errorFrom(resp)
	}
	return resp.Body, nil
}

// Profile is the user the service runs for (user:profile).
type Profile struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Locale      string `json:"locale"`
	Timezone    string `json:"timezone"`
}

// User returns the profile of the user the service runs for.
func (c *Client) User(ctx context.Context) (*Profile, error) {
	var p Profile
	if err := c.do(ctx, http.MethodGet, "/user", nil, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// Notify creates a notification for the user. kind is optional and is
// namespaced by core under the app ("app:<id>:<kind>"); title is required.
func (c *Client) Notify(ctx context.Context, kind, title, body string) error {
	return c.do(ctx, http.MethodPost, "/notify", map[string]string{"kind": kind, "title": title, "body": body}, nil)
}

// Publish event sends payload to the user's change channel as
// "apps:<app_id>"; the app's own web UI and companion apps receive it through
// plum.events / GET /api/events.
func (c *Client) PublishEvent(ctx context.Context, payload any) error {
	return c.do(ctx, http.MethodPost, "/events", map[string]any{"payload": payload}, nil)
}

// Entitlement is a paid feature the user holds for this app.
type Entitlement struct {
	SKU       string    `json:"sku"`
	Kind      string    `json:"kind"`
	ExpiresAt time.Time `json:"expires_at"`
	Active    bool      `json:"active"`
}

// Entitlements returns the user's active entitlements for this app. Boxes
// without the store receipt feature return ErrNotImplemented; treat that as
// "nothing paid".
func (c *Client) Entitlements(ctx context.Context) ([]Entitlement, error) {
	var out struct {
		SKUs []Entitlement `json:"skus"`
	}
	if err := c.do(ctx, http.MethodGet, "/entitlement", nil, &out); err != nil {
		return nil, err
	}
	return out.SKUs, nil
}
