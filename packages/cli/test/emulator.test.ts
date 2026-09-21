// Native emulator mode, against a local stand-in for the GitHub release API
// (never the real one) and a fake core binary.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chooseMode, dataDir, ensureBinary, EMULATOR_RELEASE, hostTarget, logPath, nativeRunning, nativeTokenPath,
  parseChecksums, pidPath, readState, readToken, resolveRelease, startNative, stopNative, unsupportedPlatform, writeState,
} from '../src/emulator.js';

const cache = mkdtempSync(join(tmpdir(), 'plumdev-cache-'));
const data = mkdtempSync(join(tmpdir(), 'plumdev-data-'));
const host = hostTarget()!;
const ASSET = EMULATOR_RELEASE.binary(host.goos, host.goarch);

const CORE = Buffer.from('#!/bin/sh\necho fake core\n');
const CORE_SHA = createHash('sha256').update(CORE).digest('hex');

let base = '';
let server: ReturnType<typeof createServer>;
let hits: string[] = [];
/** Flipped by one test to serve a digest that does not match the bytes. */
let corrupt = false;

function release(tag: string, at: string, extra: Record<string, unknown> = {}) {
  const assets = [ASSET, EMULATOR_RELEASE.checksums].map((name) => ({ name, browser_download_url: `${base}/dl/${tag}/${name}` }));
  return { tag_name: tag, published_at: at, draft: false, prerelease: false, assets, ...extra };
}

beforeAll(async () => {
  process.env.PLUM_DEV_CACHE = cache;
  process.env.PLUM_DEV_DATA = data;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push(req.url!);
    const u = new URL(req.url!, 'http://x');
    const json = (o: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === `/repos/${EMULATOR_RELEASE.repo}/releases`) {
      return json([
        release('v0.4.0', '2026-09-21T00:00:00Z'), // not an emulator tag
        release('emulator-1.11.9', '2026-09-22T00:00:00Z', { draft: true }), // a draft is not published
        release('emulator-1.11.2', '2026-09-20T00:00:00Z'),
        release('emulator-1.11.0', '2026-09-01T00:00:00Z'),
      ]);
    }
    const tagged = /^\/repos\/(.+)\/releases\/tags\/(.+)$/.exec(u.pathname);
    if (tagged) return json(release(decodeURIComponent(tagged[2]!), '2026-09-01T00:00:00Z'));
    const dl = /^\/dl\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (dl) {
      if (dl[2] === EMULATOR_RELEASE.checksums) {
        const digest = corrupt ? '0'.repeat(64) : CORE_SHA;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(`${digest}  ${ASSET}\n${'1'.repeat(64)}  plum-server-other-arch\n`);
      }
      if (dl[2] === ASSET) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(CORE);
      }
    }
    res.writeHead(404);
    res.end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await stopNative().catch(() => {});
  server.close();
});

describe('release resolution', () => {
  it('picks the newest emulator-* tag, ignoring drafts and other tags', async () => {
    const r = await resolveRelease({ apiBase: base });
    expect(r.tag).toBe('emulator-1.11.2');
    expect(r.version).toBe('1.11.2');
    expect(r.assets[ASSET]).toBe(`${base}/dl/emulator-1.11.2/${ASSET}`);
  });

  it('--core-version pins one, with or without the tag prefix', async () => {
    expect((await resolveRelease({ version: '1.11.0', apiBase: base })).tag).toBe('emulator-1.11.0');
    expect((await resolveRelease({ version: 'emulator-1.10.0', apiBase: base })).tag).toBe('emulator-1.10.0');
  });

  it('parses the sha256sum format (two spaces, optional *)', () => {
    const m = parseChecksums(`${CORE_SHA}  plum-server-linux-arm64\n${'2'.repeat(64)} *plum-server-darwin-arm64\n# comment\n`);
    expect(m['plum-server-linux-arm64']).toBe(CORE_SHA);
    expect(m['plum-server-darwin-arm64']).toBe('2'.repeat(64));
  });

  it('names the platform and Docker when there is no asset for it', () => {
    const msg = unsupportedPlatform();
    for (const p of EMULATOR_RELEASE.platforms) expect(msg).toContain(p);
    expect(msg).toContain('--docker');
  });
});

describe('the cached core binary', () => {
  it('downloads it once, verifies it against SHA256SUMS, and makes it executable', async () => {
    hits = [];
    const first = await ensureBinary({ apiBase: base });
    expect(first.version).toBe('1.11.2');
    expect(first.downloaded).toBe(true);
    expect(first.path).toBe(join(cache, '1.11.2', ASSET));
    expect(readFileSync(first.path)).toEqual(CORE);
    expect(statSync(first.path).mode & 0o777).toBe(0o755);
    expect(hits.some((h) => h.endsWith(`/${EMULATOR_RELEASE.checksums}`))).toBe(true);

    // Cached: no HTTP at all the second time, even for the release list.
    hits = [];
    const again = await ensureBinary({ version: '1.11.2', apiBase: base });
    expect(again.downloaded).toBe(false);
    expect(again.path).toBe(first.path);
    expect(hits).toEqual([]);
  });

  it('refuses and deletes a download whose digest does not match', async () => {
    corrupt = true;
    try {
      await expect(ensureBinary({ version: '9.9.9', apiBase: base })).rejects.toThrow(/does not match SHA256SUMS/);
    } finally {
      corrupt = false;
    }
    expect(existsSync(join(cache, '9.9.9', ASSET))).toBe(false);
    expect(existsSync(join(cache, '9.9.9', ASSET + '.part'))).toBe(false);
  });
});

describe('mode selection', () => {
  it('--docker and --native cannot both be given', () => {
    expect(() => chooseMode({ docker: true, native: true }, true)).toThrow(/contradict/);
  });

  it('a forced flag wins, and everything after `up` follows the recorded mode', () => {
    expect(chooseMode({ native: true }, true)).toBe('native');
    expect(chooseMode({ docker: true }, true)).toBe('docker');
    writeState({ mode: 'docker', version: 'image', port: 8080, box: 'http://127.0.0.1:8080' });
    expect(chooseMode({}, false)).toBe('docker');
    writeState({ mode: 'native', version: '1.11.2', port: 8080, box: 'http://127.0.0.1:8080' });
    expect(chooseMode({}, false)).toBe('native');
  });
});

describe('the native child process', () => {
  const fake = join(mkdtempSync(join(tmpdir(), 'plumdev-core-')), 'plum-server');

  beforeAll(() => {
    // Stands in for the closed core: takes the same flags, seeds the same PAT.
    writeFileSync(fake, `#!/usr/bin/env node
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const a = process.argv.slice(2);
const port = Number(a[a.indexOf('-port') + 1]);
const dir = a[a.indexOf('-data-dir') + 1];
if (process.env.PLUMBOX_EMULATOR !== '1') { console.error('PLUMBOX_EMULATOR not set'); process.exit(2); }
mkdirSync(join(dir, 'emulator'), { recursive: true });
writeFileSync(join(dir, 'emulator', 'pat.txt'), 'plum_pat_fake_token\\n');
console.log('fake core on ' + port + ' data ' + dir);
createServer((_, res) => res.end('ok')).listen(port, '127.0.0.1');
`, { mode: 0o755 });
    chmodSync(fake, 0o755);
  });

  it('starts, answers on its port, seeds the token, and stops on SIGTERM', async () => {
    const { state, ready } = await startNative({ binary: fake, version: '1.11.2', port: 18080 });
    expect(ready).toBe(true);
    expect(state.mode).toBe('native');
    expect(state.box).toBe('http://127.0.0.1:18080');
    expect(existsSync(pidPath())).toBe(true);
    expect(nativeRunning()?.pid).toBe(state.pid);
    expect(await (await fetch(state.box)).text()).toBe('ok');

    expect(nativeTokenPath()).toBe(join(dataDir(), 'emulator', 'pat.txt'));
    expect(readToken('native', 'plum-box-dev')).toBe('plum_pat_fake_token');
    expect(readFileSync(logPath(), 'utf8')).toContain('fake core on 18080');

    // A second `up` refuses rather than fighting over the port.
    await expect(startNative({ binary: fake, version: '1.11.2', port: 18080 })).rejects.toThrow(/already running/);

    expect(await stopNative()).toBe('stopped');
    expect(nativeRunning()).toBeNull();
    expect(existsSync(pidPath())).toBe(false);
    expect(readState()?.pid).toBeUndefined();
    expect(await stopNative()).toBe('not running');
  }, 40_000);

  it('reports the exit of a core that dies immediately, with its log', async () => {
    const dead = join(mkdtempSync(join(tmpdir(), 'plumdev-core-')), 'plum-server');
    writeFileSync(dead, '#!/bin/sh\necho "mount check failed" >&2\nexit 1\n', { mode: 0o755 });
    chmodSync(dead, 0o755);
    await expect(startNative({ binary: dead, version: 'x', port: 18081 })).rejects.toThrow(/exited right away[\s\S]*mount check failed/);
  }, 40_000);

  it('says where the token should be when the emulator has not written one', () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(nativeTokenPath(), '');
    expect(() => readToken('native', 'plum-box-dev')).toThrow(/is empty/);
  });
});
