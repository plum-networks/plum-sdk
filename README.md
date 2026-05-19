# Plum SDK

Browser-side JavaScript library that lets `.plu` apps talk to a host
**Plum Box** (`plum-box-core`) — file open/save, current user info, host metadata.

The SDK is **not bundled into apps**; the host serves it at a fixed path
(`/apps/runtime/plum-sdk.js`) so every app on a given device shares one
script tag and stays in sync with the device's API version.

## Repo contents

| File | Purpose |
|---|---|
| `PLUM_SDK_v0.1.md` | API specification (TypeScript-style types + semantics). Source of truth. |
| `src/plum-sdk-mock.js` | Drop-in stub for offline development. Same API surface, file pickers go through `<input type=file>`, writes trigger browser downloads. App authors copy this into their repo's `public/` or `vendor/` directory for local dev. |
| `src/plum-sdk.js` | Real runtime. Plain JS (no build step) — host serves this verbatim at `/apps/runtime/plum-sdk.js`. Talks to `plum-box-core` over `fetch`, drives an in-page picker modal for `files.openPicker` / `saveAsPicker`. |
| `scripts/vendor-to-core.sh` | Copies `src/plum-sdk.js` into the sibling `plum-box-core` repo's embed-FS path (`web/static/apps/runtime/plum-sdk.js`). Run after editing the SDK. |

## Permission model

Host injects a prelude into each app's entry HTML:

```html
<script>window.__PLUM_APP__={id:"im.plum.word",perms:["files:read","user:profile"],version:"0.1.0"};</script>
<script src="/apps/runtime/plum-sdk.js"></script>
```

The SDK reads `window.__PLUM_APP__.perms` and throws `PermissionDeniedError`
when an app calls an API without the matching permission. **v0.1 enforcement
is client-side only** — a malicious app can still hit `/api/drive/*`
directly. Server-side enforcement (per-app session token + middleware) is
required before opening to third-party developers; tracked separately.

## Status

- v0.1 spec frozen
- mock SDK: usable for app development
- real SDK: implemented, used by `plum-box-core` at runtime
- host-side permission enforcement: **deferred** (see above)

## License

MIT — apps consume this as a host-provided runtime.
