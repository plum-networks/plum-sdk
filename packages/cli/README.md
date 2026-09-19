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
cd hello && ./build.sh
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
| `package [dir] [-o out.plu] [--rotation r.json] [--no-recovery]` | Deterministic zip (sorted entries, fixed timestamps) with `META/MANIFEST.sha256`, `META/publisher.pub`, `META/publisher.sig`, optional `META/recovery.pub` and `META/rotation.json`. Prints the sha256. |
| `sign <in.plu> [-o out.plu]` | Re-signs an existing bundle; the previous `META/` is replaced. |
| `inspect <.plu> [--json]` | Publisher, recovery key, covered files, whether the signature verifies. |
| `push [dir\|.plu] [--logs] [--watch]` | `validate` + `package` in memory, then `POST /api/apps/install` on the paired box. `--watch` re-pushes on change, `--logs` follows the service log afterwards. |
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

Errors come back as `signature_invalid`, `publisher_untrusted`,
`publisher_changed`, `countersign_required`, `app_id_mismatch`, `server_bin_arch`.

## Environment

- `PLUM_DEV_HOME` — config directory (default `~/.config/plum-dev`).
- `PLUM_DEV_KEY` — publisher key path.
- Node ≥ 18. No runtime dependencies.

The signing format is shared with the box's Go implementation (`cmd/plu` in
plum-box-core); the test suite cross-checks against it when that tool is on
the machine.

## Emulator (no box needed)

`plum-box-dev` is the Plum Box in a container (the closed core binary, like an Android system image):

```
plum-dev emulator up            # docker compose up -d  (ghcr.io/plum-networks/plum-box-dev)
plum-dev emulator login         # reads the developer token out of the container
plum-dev push --target emulator # or: PLUM_DEV_TARGET=emulator
```

Web UI at http://localhost:8080 (`dev` / `plumbox-dev`). Unsigned bundles and host-architecture binaries are
accepted there and only there; `plum-dev validate` still warns about anything the store would refuse.
`emulator logs -f`, `emulator token`, `emulator down --volumes` (reset). Details: the core repo's `emulator/README.md`.
