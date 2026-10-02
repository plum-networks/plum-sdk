# @plumbox/dev — `plum-dev`

The developer CLI for Plum Box apps: the equivalent of `adb install` or Xcode
Run. You sign builds with **your own key**, pair that key with **your own
box**, and install straight from your laptop. The store is not involved and
nothing unsigned ever runs on a real box.

```
npm i -g @plumbox/dev
plum-dev keygen                      # once: publisher key + recovery key
plum-dev pair https://pb-1234.plumbox.me   # the owner reads a 6-digit code off the box
plum-dev init hello --template server-go
cd hello && plum-dev build           # cross-compile the service for the box (arm64)
plum-dev push --logs                 # sign → install → follow the service log
```

## Commands

| Command | What it does |
|---|---|
| `keygen [--force]` | Creates `~/.config/plum-dev/publisher.key` and `publisher.key.recovery` (Ed25519, mode 0600) plus `recovery.pub`. Move the recovery key offline. |
| `pair <box-url> [--name] [--namespace dev.me.]` | Asks the box to trust your key for apps under your namespace. The owner sees a 6-digit code in Settings › Developer; you type it in. Saves a developer token (`apps:install` + `apps:dev`) to `credentials.json`. |
| `login --box <url> --token <plum_pat_…>` | Use a token you created yourself instead of pairing. `login --publisher-token <plum_pub_…>` saves a store publishing token. |
| `init <name> [--template panel\|server-go] [--id]` | Scaffolds an app that already passes `validate`. |
| `validate [dir\|.plu] [--allow-host-arch]` | The box's rules, locally: manifest fields, permissions, limits, entry/icon presence, arm64 ELF check for `server.bin`, size caps. |
| `package [dir] [-o out.plu] [--rotation r.json] [--no-recovery]` | Deterministic zip (sorted entries, fixed timestamps) with `META/MANIFEST.sha256`, `META/publisher.pub`, `META/publisher.sig`, optional `META/recovery.pub` + `META/recovery.sig` (see [Recovery key](#recovery-key)) and `META/rotation.json`. Prints the sha256. |
| `sign <in.plu> [-o out.plu]` | Re-signs an existing bundle; the previous `META/` is replaced (including any `recovery.sig`, which is re-made for your `recovery.pub`). |
| `inspect <.plu> [--json]` | Publisher, recovery key and whether the publisher signed it, covered files, whether the signature verifies. |
| `build [dir] [--template go\|rust\|zig\|dockerfile]` | Cross-builds the service to the path `manifest.server.bin` names, for linux/arm64. Go needs no Docker (`CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w'`); other toolchains go through `docker buildx build --platform linux/arm64` with a generated Dockerfile (or your own `Dockerfile.plum`, final stage holding the binary at `/svc`). The result must be a static arm64 ELF or it is refused, naming what it found. |
| `push [dir\|.plu] [--logs] [--watch] [--build\|--no-build]` | `validate` + `package` in memory, then `POST /api/apps/install` on the paired box. Builds the service first when `server.bin` is not there yet (`--build` forces, `--no-build` skips). `--watch` re-pushes on change, `--logs` follows the service log afterwards. |
| `logs <app-id> [-f]` | Retained service stdout/stderr; `-f` streams (SSE). |
| `status`, `restart`, `uninstall <app-id>` | What they say. |
| `serve [dir] [--port 4040] [--service URL]` | Runs a panel on your laptop: static files under `/apps/<id>/`, the mock SDK at `/apps/runtime/plum-sdk.js`, and `/apps/<id>/svc/*` proxied to `--service` with the same `X-Plum-*` identity headers the box injects. |
| `rotate --app-id <id> (--old <key> \| --recovery <key> --old-pub <pub>)` | Writes a signed rotation record so boxes accept a new key for an app you already shipped. Include it with `package --rotation`. |
| `publish [dir\|.plu] [--store URL] [--token plum_pub_…] [--channel beta]` | Signs (like `package`) and uploads to Plum Store with a publisher token from developer.plum.im › CLI tokens (`login --publisher-token …` saves it; `PLUM_PUBLISHER_TOKEN` works too). The store verifies the signature against your registered key and queues the version for review; `--channel beta` skips review and goes straight to your beta boxes. |
| `testers <app-id> [list \| add <serial> \| rm <serial>]` | Which boxes receive the app's beta channel. |
| `escrow seal [--recovery-key] [-o blob.txt]` / `escrow open <blob.txt>` | Encrypts the key file with a passphrase (scrypt + AES-256-GCM) for the console's escrow, and restores it. The store never sees the passphrase. |
| `whoami` | Config dir, key, paired box. |

`.plumignore` in the app directory lists paths to leave out of the bundle (one
per line). `node_modules`, `.git`, dotfiles and `META/` are always skipped.

## How the box decides

1. The zip must carry a publisher signature over every file (`META/`). Unsigned
   bundles are refused at every trust level.
2. The signing key must be trusted by the owner: the store's countersign
   (published apps), a paired developer key (yours, for your namespace), or, if
   the owner opted into it, any signed publisher.
3. Updates must come from the same key as the installed version, or carry a
   rotation record signed by the old key or the recovery key.
4. `server.bin` must be an arm64 ELF.
5. The recovery key on record changes only when the new one is vouched for —
   see below.

## Recovery key

`keygen` writes `recovery.pub` next to your publisher key, and every bundle
you sign carries it as `META/recovery.pub`. A box writes that key down at
install; later, a rotation record signed by it moves the app to a new
publisher key even if the old one is lost.

`MANIFEST.sha256` lists only the app's files, so the publisher signature does
not cover anything under `META/` — on its own, `recovery.pub` is signed by
nobody, and anyone who re-zips one of your bundles could put their own key
there. So the CLI also writes **`META/recovery.sig`**: an Ed25519 signature by
your *publisher* key over

```
plum-recovery-v1\n<app id>\ned25519:<base64url recovery key>
```

(purpose line, `manifest.json`'s `id`, the key in its canonical form; no
trailing newline), stored as unpadded base64url plus `\n`. It is the same
format plum-box-core's own signer writes (`trust.Signer.SignZip`), and the test
suite checks it byte for byte against a vector from that code — and, when a
core checkout is available (`PLUM_CORE_DIR`), against the box's verifier
itself.

What a box does with the recovery key in a bundle:

| Situation | Recorded? |
|---|---|
| First install of the app on that box | yes (trust on first use, like the publisher key) |
| Same key as on record | yes (no change) |
| A different key (or one where none was recorded), signed by your publisher key in `recovery.sig` | yes |
| A different key, in a bundle from the store or with a verified store countersign | yes |
| A different key, direct install (`push`, a `.plu` file), **no** `recovery.sig` | **no** — the box keeps what it had and logs it; the install itself still succeeds |

> **Upgrading from `@plumbox/dev` 0.1.0.** 0.1.0 wrote `recovery.pub` but not
> `recovery.sig`. Bundles it built still install everywhere, but a box no
> longer takes a *changed* recovery key from them on a direct install. Re-sign
> or re-publish with this version to add the signature: `plum-dev package`
> again, or `plum-dev sign old.plu` for a bundle you only have as a file.
> `plum-dev inspect` shows `signed by the publisher (META/recovery.sig)` once
> it is there. Boxes that predate the check ignore the extra file.

Errors come back as `signature_invalid`, `publisher_untrusted`,
`publisher_changed`, `countersign_required`, `app_id_mismatch`, `server_bin_arch`.

## Environment

- `PLUM_DEV_HOME` — config directory (default `~/.config/plum-dev`).
- `PLUM_DEV_KEY` — publisher key path.
- `PLUM_DEV_TARGET` — `box` (default) or `emulator`.
- `PLUM_DEV_EMULATOR_MODE` — `docker` or `native`, instead of probing for a daemon.
- `PLUM_DEV_CACHE` — downloaded emulator cores (default `~/.cache/plum-dev/emulator`, `$XDG_CACHE_HOME` respected).
- `PLUM_DEV_DATA` — emulator data, log and pidfile (default `~/.local/share/plum-dev/emulator`, `$XDG_DATA_HOME` respected).
- Node ≥ 18. No runtime dependencies.

The signing format is shared with the box's Go implementation (`cmd/plu` in
plum-box-core); the test suite cross-checks against it when that tool is on
the machine (`PLUM_GO_PLU`, default `~/.local/bin/plu`), and against the trust
package itself when a plum-box-core checkout is at `PLUM_CORE_DIR` (or
`../plum-box-core`).

## Emulator (no box, no Docker needed)

`plum-box-dev` is the Plum Box on your machine — the closed core binary, like an Android system
image. It runs in either of two modes and the same commands drive both:

```
plum-dev emulator up            # native unless a Docker daemon answers
plum-dev emulator login         # reads the seeded developer token
plum-dev push --target emulator # or: PLUM_DEV_TARGET=emulator
```

- **native** (no Docker): downloads the prebuilt core for your platform from the public
  `plum-networks/plum-sdk` releases (tag `emulator-<core version>`, asset
  `plum-server-<goos>-<goarch>`), **verifies its SHA-256 against the release's `SHA256SUMS`
  before the first run**, caches it under `~/.cache/plum-dev/emulator/<version>/`, and runs it as
  a child process with `PLUMBOX_EMULATOR=1`. Data, logfile and pidfile live under
  `~/.local/share/plum-dev/emulator/`. Published platforms: linux-amd64, linux-arm64,
  darwin-amd64, darwin-arm64 — macOS included, so an Apple-silicon laptop needs no Docker Desktop.
  Anything else is told so by name and pointed at Docker mode.
- **docker**: `docker compose` with the shipped `emulator/docker-compose.yml`
  (`ghcr.io/plum-networks/plum-box-dev`).

`up` chooses Docker only when a daemon actually answers; `--native` and `--docker` force one, and
`--core-version <x.y.z>` pins a core. Every other subcommand (`down`, `logs -f`, `token`, `login`,
`status`) follows the mode `up` recorded, so nothing waits on a daemon that has gone away.
`down` is SIGTERM then SIGKILL after 5s; `down --volumes` resets the box.

Web UI at http://127.0.0.1:8080 (`dev` / `plumbox-dev`). Unsigned bundles and host-architecture
binaries are accepted there and only there; `plum-dev validate` still warns about anything the
store would refuse. Details: the emulator page in the developer docs.
