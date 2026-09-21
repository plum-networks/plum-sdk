# Plum SDK

Everything you need to build an app that runs **on** a Plum Box, or talks **to**
one. Five npm packages, one JSON Schema, one on-box JavaScript runtime.

| Package | Runs where | Use it for |
|---|---|---|
| [`@plumbox/dev`](packages/cli) (`plum-dev`) | your laptop | publisher key, pair your own box, sign + install a `.plu` without the store, follow service logs, run a panel locally |
| [`@plumbox/client`](packages/client) | outside the box (Node, desktop, Obsidian plugins) | log in once → auto-connect through Plum Relay → Drive API. No IP, port or tunnel |
| [`@plumbox/ui`](packages/ui) | inside a `.plu` panel | the phone apps' design tokens + eight framework-free web components |
| [`@plumbox/manifest`](packages/manifest) | any validator | the `manifest.json` JSON Schema, shared by the CLI, the store and the box |
| [`@plumbox/oprf`](packages/oprf) | any client | zero-knowledge box discovery: find a user's box from (email, password) without the relay learning either |
| `src/plum-sdk.js` | inside a `.plu` panel, served by the box | file pickers, user info, `plum.service` — the box serves it at `/apps/runtime/plum-sdk.js` |

Node **18 or newer** everywhere.

---

## Quickstart: your first app on your own box

Six commands. The only thing you need besides a laptop is a Plum Box you own,
reachable on the LAN or at its `*.plumbox.me` address. No store account, no
review, no internet.

### 1. Install the CLI

```bash
npm i -g @plumbox/dev
plum-dev --version          # 0.1.0
```

Not published yet? Until it is, install it from this repo:

```bash
git clone https://github.com/plum-networks/plum-sdk
cd plum-sdk && npm ci && npm run build -w @plumbox/dev
npm i -g ./packages/cli     # puts `plum-dev` on your PATH
# or, without touching the global prefix:
node packages/cli/dist/cli.js --version
```

### 2. Make a publisher key

```bash
plum-dev keygen
```

Writes an Ed25519 signing key to `~/.config/plum-dev/publisher.key` (mode 0600)
and a **recovery key** next to it. Every `.plu` you build is signed with the
publisher key; the recovery key is what lets you hand boxes a new publisher key
if you ever lose the first one, without going through Plum. Move the recovery
key offline and delete it from the laptop — the CLI only needs the public half
(`~/.config/plum-dev/recovery.pub`), which it embeds in each bundle.

Override the paths with `PLUM_DEV_HOME` (config dir) and `PLUM_DEV_KEY` (key
file) — that is how CI passes a key in; see
[plum-publish-action](https://github.com/plum-networks/plum-publish-action).

### 3. Scaffold an app

```bash
plum-dev init "Hello Panel"                        # a web panel
plum-dev init "Hello Server" --template server-go  # panel + a Go service on the box
```

You get `manifest.json`, `index.html` (with the runtime SDK script tag),
`.plumignore` and a README. `--template server-go` adds `server/main.go`
(using the `plumsvc` Go module), a `build.sh` that cross-compiles for arm64,
and a manifest `server` block:

```jsonc
"server": { "bin": "svc", "healthPath": "/healthz",
            "limits": { "memory": "128M", "cpu": 50, "pids": 32 } }
```

The app id defaults to `dev.<your-username>.<slug>`; pass `--id` to choose it,
`--dir` to put it somewhere other than `./<slug>`.

### 4. Run the panel on your laptop

```bash
cd hello-panel
plum-dev serve                                     # http://127.0.0.1:4040/apps/<id>/
plum-dev serve --service http://127.0.0.1:8080     # …and proxy plum.service to a local backend
```

`serve` injects `plum-sdk-mock.js` at the same path the box serves the real SDK
from, so `plum.files`, `plum.user` and `plum.service` all answer. With
`--service` it also mounts `/apps/<id>/svc/*` in front of your backend and adds
the same `X-Plum-User-Id` / `X-Plum-Username` / `X-Plum-App-Id` / `X-Plum-Perms`
headers the box injects, so the service sees the shape it will see in
production. `--port` moves it off 4040.

### 5. Pair with your box (once)

```bash
plum-dev pair https://pb-1234.plumbox.me
# or on the LAN:  plum-dev pair 192.168.0.10:8443 --insecure
```

The box shows a **6-digit code** in Settings › Developer (and in the Plum app);
type it at the prompt, or pass `--code 123456`. The box then trusts your
publisher key for app ids under your namespace only (`dev.<you>.` by default,
`--namespace` to change it) and hands back a developer token, which the CLI
saves to `~/.config/plum-dev/credentials.json` (0600). Because the code is
shown *on the box*, you cannot pair with someone else's.

Already have a token? `plum-dev login --box <url> --token plum_pat_…`
(it needs the `apps:install` and `apps:dev` scopes).

### 6. Sign, install, watch it run

```bash
./build.sh            # server-go template only: GOOS=linux GOARCH=arm64
plum-dev validate     # the box's own manifest, ELF and zip rules, locally
plum-dev push --logs  # sign → install → follow the service's stdout/stderr
```

`push` prints the URL the app is now live at. Add `--watch` to re-push on every
file change, and `--target emulator` to send it to a local
[`plum-box-dev`](packages/cli/README.md#emulator-no-box-needed) container instead of the real box.

Useful afterwards:

```bash
plum-dev logs <app-id> -f     # follow service logs
plum-dev status <app-id>      # state, restarts, memory, cgroup limits
plum-dev restart <app-id>
plum-dev uninstall <app-id>
plum-dev inspect app.plu      # who signed it, what it covers, does it verify
plum-dev whoami               # key, box, namespace, store token
```

### Later: the store

```bash
plum-dev login --publisher-token plum_pub_…   # from developer.plum.im › CLI tokens
plum-dev publish --channel beta               # your beta boxes, no human review
plum-dev testers <app-id> add <box-serial>
plum-dev publish --channel public             # goes to the review queue
```

`plum-dev package [-o out.plu]` builds the same deterministic, signed bundle
without uploading it — that is what CI archives.

Full command reference: [`packages/cli/README.md`](packages/cli/README.md).

---

## On-box runtime (`src/plum-sdk.js`)

Browser-side JavaScript that lets `.plu` panels talk to the host box —
file open/save, current user, host metadata, `plum.service` calls to the app's
own backend.

The SDK is **not bundled into apps**: the host serves it at a fixed path
(`/apps/runtime/plum-sdk.js`) so every app on a device shares one script tag and
stays in step with that device's API version.

The box injects a prelude into each app's entry HTML:

```html
<script>window.__PLUM_APP__={id:"im.plum.word",perms:["files:read","user:profile"],version:"0.1.0"};</script>
<script src="/apps/runtime/plum-sdk.js"></script>
```

## Repo contents

| Path | Purpose |
|---|---|
| `packages/` | the five npm packages above |
| `plumsvc/` | Go module for services that run on the box (`github.com/plum-networks/plum-sdk/plumsvc`) |
| `PLUM_SDK_v0.1.md` / `PLUM_SDK_v0.2.md` | runtime API specification (TypeScript-style types + semantics) |
| `PLUM_NATIVE_BRIDGE_v1.md` | the native bridge the Plum phone apps expose to panels |
| `src/plum-sdk.js` | the real runtime, served verbatim by the box |
| `src/plum-sdk-mock.js` | drop-in stub for offline development; `plum-dev serve` injects it |
| `examples/bridge-check` | a panel that exercises every bridge call |
| `scripts/vendor-to-core.sh` | copies `src/plum-sdk.js` into `plum-box-core`'s embed path — run after editing the SDK |
| `scripts/publish.sh`, [`RELEASING.md`](RELEASING.md) | how these packages get to npm |

## Permission model

The SDK reads `window.__PLUM_APP__.perms` and throws `PermissionDeniedError`
when an app calls an API without the matching permission. That is a courtesy to
honest apps, not a fence: the box enforces the same permissions server-side on
`/api/apps/*` and on the `/apps/{id}/svc/*` proxy, and a `.plu` only installs at
all if it carries a signature from a publisher key the box's owner trusts.

## Development

```bash
npm ci
npm run build --workspaces
npm test --workspaces
```

## License

MIT — see [LICENSE](LICENSE). Each package ships its own copy.
