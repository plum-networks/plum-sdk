// The emulator — a Plum Box on this machine — in either of two modes.
//
//   docker  the published image, run by `docker compose` (emulator/docker-compose.yml)
//   native  the prebuilt closed core binary for this platform, downloaded from
//           the public plum-sdk releases, verified, and run as a child process
//           with PLUMBOX_EMULATOR=1
//
// Native mode exists because Docker is a big ask for someone who only wants to
// try an app against a real core: no daemon, no image, no root. `emulator up`
// uses Docker only when a daemon actually answers; otherwise it goes native.
// --native / --docker force one.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the prebuilt emulator core comes from. This is the single place the
 * release layout is written down — the release that publishes the assets has
 * to match it name for name:
 *
 *   https://github.com/plum-networks/plum-sdk/releases/tag/emulator-<core version>
 *     plum-server-linux-amd64
 *     plum-server-linux-arm64
 *     plum-server-darwin-amd64
 *     plum-server-darwin-arm64
 *     SHA256SUMS          one "<sha256>  plum-server-<goos>-<goarch>" line each
 *
 * The repository is the public SDK one on purpose: the core sources stay
 * closed, but the binary that developers need must be pullable without a
 * token, like an Android system image.
 */
export const EMULATOR_RELEASE = {
  repo: 'plum-networks/plum-sdk',
  api: 'https://api.github.com',
  downloads: 'https://github.com',
  tagPrefix: 'emulator-',
  binary: (goos: string, goarch: string): string => `plum-server-${goos}-${goarch}`,
  checksums: 'SHA256SUMS',
  platforms: ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'] as readonly string[],
  /** The published URL shape; the API hands back the same string as browser_download_url. */
  url: (tag: string, asset: string): string => `${EMULATOR_RELEASE.downloads}/${EMULATOR_RELEASE.repo}/releases/download/${tag}/${asset}`,
} as const;

export const DEFAULT_PORT = 8080;
export const CONTAINER_NAME = 'plum-box-dev';

export type Mode = 'docker' | 'native';

// ---------------------------------------------------------------- locations

/** ~/.cache/plum-dev/emulator (XDG_CACHE_HOME, or PLUM_DEV_CACHE for tests). */
export function cacheRoot(): string {
  return process.env.PLUM_DEV_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'plum-dev', 'emulator');
}

/** ~/.local/share/plum-dev/emulator (XDG_DATA_HOME, or PLUM_DEV_DATA for tests). */
export function dataRoot(): string {
  return process.env.PLUM_DEV_DATA || join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'plum-dev', 'emulator');
}

export const dataDir = (): string => join(dataRoot(), 'data');
export const storageDir = (): string => join(dataRoot(), 'storage');
export const pidPath = (): string => join(dataRoot(), 'plum-box-dev.pid');
export const logPath = (): string => join(dataRoot(), 'plum-box-dev.log');
export const statePath = (): string => join(dataRoot(), 'state.json');
/** The seeded developer PAT, written by the core on first boot. */
export const nativeTokenPath = (): string => join(dataDir(), 'emulator', 'pat.txt');

/** emulator/docker-compose.yml as shipped inside the package. */
export function composeFile(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'emulator', 'docker-compose.yml');
}

// ------------------------------------------------------------------- docker

export function dockerCli(args: string[], opts: { capture?: boolean } = {}): string {
  const r = spawnSync('docker', args, { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (r.error) throw new Error(`docker is not installed or not on PATH (${r.error.message}) — run the emulator without it: plum-dev emulator up --native`);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed (exit ${r.status})`);
  return r.stdout ?? '';
}

/** True only when a daemon answers — an installed client with no daemon is not Docker. */
export function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000 });
  return !r.error && r.status === 0;
}

/**
 * Which mode a command runs in. `up` decides by probing; the others follow the
 * mode `up` recorded, so stopping an emulator never depends on the daemon
 * coming back.
 */
export function chooseMode(flags: { docker?: boolean; native?: boolean }, forStart: boolean): Mode {
  if (flags.docker && flags.native) throw new Error('--docker and --native contradict each other');
  if (flags.docker) return 'docker';
  if (flags.native) return 'native';
  const env = (process.env.PLUM_DEV_EMULATOR_MODE || '').toLowerCase();
  if (env === 'docker' || env === 'native') return env;
  if (!forStart) {
    const s = readState();
    if (s) return s.mode;
  }
  return dockerAvailable() ? 'docker' : 'native';
}

// -------------------------------------------------------------- host target

export function hostTarget(): { goos: string; goarch: string } | null {
  const goos = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : null;
  const goarch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!goos || !goarch || !EMULATOR_RELEASE.platforms.includes(`${goos}-${goarch}`)) return null;
  return { goos, goarch };
}

export function unsupportedPlatform(): string {
  return `no prebuilt emulator core for ${process.platform}/${process.arch} — published platforms are ${EMULATOR_RELEASE.platforms.join(', ')}.\n` +
    'Use Docker mode instead: plum-dev emulator up --docker   (or run a plum-server binary yourself: see the emulator docs)';
}

// ------------------------------------------------------------------ release

export interface Release {
  tag: string;
  version: string;
  /** asset name → download URL */
  assets: Record<string, string>;
}

interface GhAsset { name?: string; browser_download_url?: string }
interface GhRelease { tag_name?: string; draft?: boolean; prerelease?: boolean; published_at?: string; created_at?: string; assets?: GhAsset[] }

function apiBase(given?: string): string {
  return (given || process.env.PLUM_DEV_EMULATOR_API || EMULATOR_RELEASE.api).replace(/\/+$/, '');
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'plum-dev' } });
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
  return (await r.json()) as unknown;
}

function toRelease(r: GhRelease): Release {
  const tag = r.tag_name ?? '';
  const assets: Record<string, string> = {};
  for (const a of r.assets ?? []) if (a.name && a.browser_download_url) assets[a.name] = a.browser_download_url;
  return { tag, version: tag.startsWith(EMULATOR_RELEASE.tagPrefix) ? tag.slice(EMULATOR_RELEASE.tagPrefix.length) : tag, assets };
}

/** The pinned `emulator-<version>` release, or the newest one published. */
export async function resolveRelease(o: { version?: string; apiBase?: string } = {}): Promise<Release> {
  const base = apiBase(o.apiBase);
  if (o.version) {
    const tag = o.version.startsWith(EMULATOR_RELEASE.tagPrefix) ? o.version : EMULATOR_RELEASE.tagPrefix + o.version;
    let rel: GhRelease;
    try {
      rel = (await getJson(`${base}/repos/${EMULATOR_RELEASE.repo}/releases/tags/${encodeURIComponent(tag)}`)) as GhRelease;
    } catch (e) {
      if (/HTTP 404$/.test((e as Error).message)) {
        throw new Error(`github.com/${EMULATOR_RELEASE.repo} has no release tagged ${tag} — drop --core-version to take the newest one`);
      }
      throw e;
    }
    if (!rel?.tag_name) throw new Error(`no release tagged ${tag} on github.com/${EMULATOR_RELEASE.repo}`);
    return toRelease(rel);
  }
  const list = (await getJson(`${base}/repos/${EMULATOR_RELEASE.repo}/releases?per_page=100`)) as GhRelease[];
  const when = (r: GhRelease) => Date.parse(r.published_at || r.created_at || '') || 0;
  const mine = (Array.isArray(list) ? list : [])
    .filter((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith(EMULATOR_RELEASE.tagPrefix) && !r.draft)
    .sort((a, b) => when(b) - when(a));
  const pick = mine.find((r) => !r.prerelease) ?? mine[0];
  if (!pick) {
    throw new Error(`github.com/${EMULATOR_RELEASE.repo} has no ${EMULATOR_RELEASE.tagPrefix}* release yet — pin one with --core-version <x.y.z>, or use Docker mode (plum-dev emulator up --docker)`);
  }
  return toRelease(pick);
}

// -------------------------------------------------------------- the binary

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** "<sha256>  <name>" per line, the sha256sum format ("*name" for binary mode). */
export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m) out[m[2]!] = m[1]!;
  }
  return out;
}

const versionDir = (version: string): string => join(cacheRoot(), version);

/**
 * A cached binary, re-checked against the digest recorded when it was
 * downloaded. A file that no longer matches is deleted, not run.
 */
function cached(version: string, name: string): string | null {
  const bin = join(versionDir(version), name);
  const marker = bin + '.sha256';
  if (!existsSync(bin) || !existsSync(marker)) return null;
  const want = readFileSync(marker, 'utf8').trim();
  if (sha256(readFileSync(bin)) !== want) {
    rmSync(bin, { force: true });
    rmSync(marker, { force: true });
    return null;
  }
  chmodSync(bin, 0o755);
  return bin;
}

/** The newest cached version (by mtime) that still verifies — the offline path. */
function newestCached(name: string): { path: string; version: string } | null {
  const root = cacheRoot();
  if (!existsSync(root)) return null;
  const rows: Array<{ version: string; at: number }> = [];
  for (const v of readdirSync(root)) {
    const bin = join(root, v, name);
    if (!existsSync(bin)) continue;
    rows.push({ version: v, at: statSync(bin).mtimeMs });
  }
  rows.sort((a, b) => b.at - a.at);
  for (const r of rows) {
    const hit = cached(r.version, name);
    if (hit) return { path: hit, version: r.version };
  }
  return null;
}

export interface EnsureResult { path: string; version: string; downloaded: boolean }

/**
 * The core binary for this platform, downloaded once into
 * ~/.cache/plum-dev/emulator/<version>/ and verified against the release's
 * SHA256SUMS before it is ever executed.
 */
export async function ensureBinary(o: { version?: string; apiBase?: string; log?: (s: string) => void } = {}): Promise<EnsureResult> {
  const host = hostTarget();
  if (!host) throw new Error(unsupportedPlatform());
  const name = EMULATOR_RELEASE.binary(host.goos, host.goarch);
  const log = o.log ?? (() => {});

  if (o.version) {
    const hit = cached(o.version, name);
    if (hit) return { path: hit, version: o.version, downloaded: false };
  }

  let rel: Release;
  try {
    rel = await resolveRelease(o);
  } catch (e) {
    const fb = newestCached(name);
    if (fb) {
      log(`could not reach the release list (${(e as Error).message}); using the cached core ${fb.version}`);
      return { ...fb, downloaded: false };
    }
    throw e;
  }

  const hit = cached(rel.version, name);
  if (hit) return { path: hit, version: rel.version, downloaded: false };

  const url = rel.assets[name];
  if (!url) {
    throw new Error(`release ${rel.tag} carries no ${name} (it has: ${Object.keys(rel.assets).join(', ') || 'nothing'}) — this platform has no prebuilt core there.\nUse Docker mode instead: plum-dev emulator up --docker`);
  }
  const sumsUrl = rel.assets[EMULATOR_RELEASE.checksums];
  if (!sumsUrl) throw new Error(`release ${rel.tag} has no ${EMULATOR_RELEASE.checksums}; refusing to run a binary nothing vouches for`);

  const sumsRes = await fetch(sumsUrl, { headers: { 'User-Agent': 'plum-dev' } });
  if (!sumsRes.ok) throw new Error(`GET ${sumsUrl}: HTTP ${sumsRes.status}`);
  const want = parseChecksums(await sumsRes.text())[name];
  if (!want) throw new Error(`${EMULATOR_RELEASE.checksums} of ${rel.tag} does not list ${name}; refusing to run an unverified binary`);

  log(`downloading the emulator core ${rel.version} for ${host.goos}-${host.goarch}…`);
  const res = await fetch(url, { headers: { 'User-Agent': 'plum-dev' } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  mkdirSync(versionDir(rel.version), { recursive: true });
  const bin = join(versionDir(rel.version), name);
  const part = bin + '.part';
  writeFileSync(part, buf, { mode: 0o755 });
  const got = sha256(buf);
  if (got !== want) {
    rmSync(part, { force: true });
    throw new Error(`${name} from ${rel.tag} does not match ${EMULATOR_RELEASE.checksums} (want ${want}, got ${got}) — deleted; refusing to run it`);
  }
  renameSync(part, bin);
  chmodSync(bin, 0o755);
  writeFileSync(bin + '.sha256', got + '\n', { mode: 0o644 });
  return { path: bin, version: rel.version, downloaded: true };
}

// ------------------------------------------------------------- native state

export interface State {
  mode: Mode;
  version: string;
  port: number;
  box: string;
  pid?: number;
  binary?: string;
  container?: string;
  started_at?: string;
}

export function readState(): State | null {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as State;
  } catch {
    return null;
  }
}

export function writeState(s: State): void {
  mkdirSync(dataRoot(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The state of a native emulator that is actually running, or null. */
export function nativeRunning(): State | null {
  const s = readState();
  if (!s || s.mode !== 'native' || !s.pid || !alive(s.pid)) return null;
  return s;
}

function waitForPort(port: number, pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const attempt = () => {
      if (!alive(pid)) return resolve(false);
      const sock = connect({ host: '127.0.0.1', port });
      sock.setTimeout(1000);
      const retry = () => {
        sock.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 200);
      };
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', retry);
      sock.once('error', retry);
    };
    attempt();
  });
}

export function tail(file: string, lines: number): string {
  if (!existsSync(file)) return '';
  const all = readFileSync(file, 'utf8').split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  return all.slice(-lines).join('\n');
}

/**
 * Starts the core as a detached child: log and pidfile in the data dir, the
 * seeded owner and the relaxations the emulator image uses.
 */
export async function startNative(o: { binary: string; version: string; port: number }): Promise<{ state: State; ready: boolean }> {
  const running = nativeRunning();
  if (running) throw new Error(`the emulator is already running (pid ${running.pid}, ${running.box}) — plum-dev emulator down first`);
  mkdirSync(dataDir(), { recursive: true });
  mkdirSync(storageDir(), { recursive: true });
  const fd = openSync(logPath(), 'a');
  const child = spawn(o.binary, [
    '-port', String(o.port),
    '-data-dir', dataDir(),
    '-storage-dir', storageDir(),
    '-dev-skip-mount-check',
  ], {
    cwd: dataRoot(),
    detached: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      PLUMBOX_EMULATOR: '1',
      PLUMBOX_DEV_OWNER_EMAIL: process.env.PLUMBOX_DEV_OWNER_EMAIL || 'dev@plum.local',
      PLUMBOX_DEV_OWNER_USER: process.env.PLUMBOX_DEV_OWNER_USER || 'dev',
      PLUMBOX_DEV_OWNER_PASSWORD: process.env.PLUMBOX_DEV_OWNER_PASSWORD || 'plumbox-dev',
    },
  });
  closeSync(fd);
  if (!child.pid) throw new Error(`could not start ${o.binary}`);
  child.unref();
  writeFileSync(pidPath(), String(child.pid) + '\n');
  const state: State = {
    mode: 'native', version: o.version, port: o.port, box: `http://127.0.0.1:${o.port}`,
    pid: child.pid, binary: o.binary, started_at: new Date().toISOString(),
  };
  writeState(state);
  const ready = await waitForPort(o.port, child.pid, 20_000);
  if (!ready && !alive(child.pid)) {
    rmSync(pidPath(), { force: true });
    writeState({ ...state, pid: undefined });
    throw new Error(`the emulator core exited right away. Last lines of ${logPath()}:\n${tail(logPath(), 20)}`);
  }
  return { state, ready };
}

/** SIGTERM, then SIGKILL after 5s. */
export async function stopNative(): Promise<'stopped' | 'killed' | 'not running'> {
  const s = readState();
  const pid = s?.pid ?? Number(existsSync(pidPath()) ? readFileSync(pidPath(), 'utf8').trim() : NaN);
  if (!pid || Number.isNaN(pid) || !alive(pid)) {
    rmSync(pidPath(), { force: true });
    if (s) writeState({ ...s, pid: undefined });
    return 'not running';
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* gone between the check and the signal */
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && alive(pid)) await new Promise((r) => setTimeout(r, 100));
  let how: 'stopped' | 'killed' = 'stopped';
  if (alive(pid)) {
    how = 'killed';
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* raced us */
    }
    while (alive(pid)) await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(pidPath(), { force: true });
  if (s) writeState({ ...s, pid: undefined });
  return how;
}

/** Prints the logfile as it grows (Ctrl-C to stop); never returns. */
export function followLog(file: string, out: (s: string) => void): Promise<never> {
  let at = existsSync(file) ? statSync(file).size : 0;
  return new Promise<never>(() => {
    setInterval(() => {
      if (!existsSync(file)) return;
      const size = statSync(file).size;
      if (size === at) return;
      if (size < at) at = 0; // truncated
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(size - at);
      try {
        const n = readSync(fd, buf, 0, buf.length, at);
        at += n;
        const text = buf.subarray(0, n).toString('utf8').replace(/\n$/, '');
        if (text) out(text);
      } finally {
        closeSync(fd);
      }
    }, 300);
  });
}

/** The seeded PAT, from the container or from the native data dir. */
export function readToken(mode: Mode, container: string): string {
  if (mode === 'docker') return dockerCli(['exec', container, 'cat', '/data/plum/emulator/pat.txt'], { capture: true }).trim();
  const p = nativeTokenPath();
  if (!existsSync(p)) throw new Error(`${p} not found — is the emulator up? (plum-dev emulator up)`);
  const tok = readFileSync(p, 'utf8').trim();
  if (!tok) throw new Error(`${p} is empty — the core may still be seeding; try again in a moment`);
  return tok;
}

/** Deletes the native data dir (the `--volumes` of Docker mode). */
export function resetNative(): void {
  rmSync(dataDir(), { recursive: true, force: true });
  rmSync(storageDir(), { recursive: true, force: true });
  rmSync(logPath(), { force: true });
  rmSync(statePath(), { force: true });
  try {
    unlinkSync(pidPath());
  } catch {
    /* already gone */
  }
}
