# plumsvc — server-side Plum SDK (Go)

The box-side counterpart of `window.plum.*`. A **server .plu** (a Plum app that
ships its own service binary, `manifest.server`) imports this to reach core
through the per-app control socket the box provides.

```go
import "github.com/plum-networks/plum-sdk/plumsvc"

svc, err := plumsvc.New()                       // needs PLUM_CTL_SOCKET (set by the box)
ln, _ := net.Listen("unix", plumsvc.ServeSocket()) // core proxies /apps/<id>/svc/* here

http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    who := plumsvc.CallerOf(r)                  // user + app + effective perms, set by core
    ...
    _ = svc.Publish(plumsvc.Files, "out/report.pdf", "Reports/report.pdf")
    _ = svc.Notify(r.Context(), "done", "Report ready", "")
    _ = svc.PublishEvent(r.Context(), map[string]any{"progress": 100})
}))
```

| Call | Permission | What |
|---|---|---|
| `Publish(root, src, dest)` | `files:write` | move a result from the app's data dir into the user's Files/Downloads |
| `Files(ctx, root, path)` | `files:read` | list a directory of the user's storage (no secret folders) |
| `Read(ctx, root, path)` | `files:read` | stream one file |
| `User(ctx)` | `user:profile` | id, username, display name, locale, timezone |
| `Notify(ctx, kind, title, body)` | — | a notification for the user (kind is namespaced to the app) |
| `PublishEvent(ctx, payload)` | — | an `apps:<id>` event on the user's change channel |
| `Entitlements(ctx)` | — | paid features the user holds (`ErrNotImplemented` on boxes without receipts) |

Authorisation is by socket ownership: the box hands the control socket to the
app's own OS account, so there is no token. Every call is scoped by core to the
verified (user, app) and gated on the app's effective manifest permissions —
the set the user may have narrowed in Settings.

The service runs under resource limits from `manifest.server.limits`
(memory, cpu, pids) and as its own OS account: it cannot read the user's files
directly, only through `Files`/`Read`.
