// Drives the real command entry points against a fake box that answers with
// the exact shapes plum-box-core uses (internal/apps/{publishers,install_direct,logs}.go).
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyPlu } from '../src/bundle.js';
import { main } from '../src/cli.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

const seen: Seen[] = [];
let box = '';
let server: ReturnType<typeof createServer>;
const home = mkdtempSync(join(tmpdir(), 'plumdev-home-'));
const work = mkdtempSync(join(tmpdir(), 'plumdev-work-'));
const TOKEN = 'plum_pat_test_0123456789';
const HAVE_GO = !spawnSync('go', ['version'], { stdio: 'ignore' }).error;

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  process.env.PLUM_DEV_HOME = home;
  server = createServer(async (req, res) => {
    const body = await read(req);
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const json = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/api/apps/publishers/pair' && req.method === 'POST') {
      const b = JSON.parse(body.toString()) as { pubkey: string; name: string; namespace_prefix: string };
      if (!b.pubkey.startsWith('ed25519:')) return json(400, { error: 'bad_request', message: 'pubkey' });
      return json(200, { pairing_id: 'pr_1', kid: 'pub-deadbeefdeadbeef', expires_in: 300, hint: 'Ask the box owner for the code shown in Settings › Developer › Pairing requests.' });
    }
    if (u.pathname === '/api/apps/publishers/pair/confirm' && req.method === 'POST') {
      const b = JSON.parse(body.toString()) as { pairing_id: string; code: string };
      if (b.pairing_id !== 'pr_1' || b.code !== '424242') return json(403, { error: 'pairing_code_invalid', message: 'wrong code' });
      return json(200, { ok: true, kid: 'pub-deadbeefdeadbeef', namespace_prefix: 'dev.tester.', trust_level: 2, token: TOKEN, token_id: 'tok_1' });
    }
    if (!authed) return json(401, { error: 'unauthorized', message: 'token required' });
    if (u.pathname === '/api/apps/install' && req.method === 'POST') {
      const v = verifyPlu(body);
      if (!v.ok) return json(422, { error: 'signature_invalid', message: v.reason });
      return json(200, { ok: true, app_id: u.searchParams.get('app_id'), version: '0.1.0', name: 'Hello', url: `/apps/${u.searchParams.get('app_id')}/`, publisher_kid: v.kid, countersign_kind: '' });
    }
    if (u.pathname === '/api/apps/dev.tester.hello/logs') {
      if (u.searchParams.get('follow') === '1') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('retry: 3000\n\n');
        res.write('data: line one\n\n');
        res.write('data: line two\n\n');
        return res.end();
      }
      return json(200, { lines: ['a', 'b'] });
    }
    if (u.pathname === '/api/apps/dev.tester.hello/status') return json(200, { state: 'ready', pid: 42 });
    if (u.pathname === '/api/apps/dev.tester.hello/restart') return json(200, { ok: true });
    if (u.pathname === '/api/apps/dev.tester.hello/uninstall') return json(200, { ok: true });
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  box = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { server.close(); });

async function run(...argv: string[]): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  try {
    await main(argv);
  } finally {
    spy.mockRestore();
  }
  return out.join('\n');
}

describe('plum-dev against a fake box', () => {
  it('keygen → pair --code → credentials with the developer token', async () => {
    const kg = await run('keygen');
    expect(kg).toContain('publisher key');
    const out = await run('pair', box, '--name', 'Tester', '--namespace', 'dev.tester.', '--code', '424242');
    expect(out).toContain('paired:');
    const creds = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')) as { box: string; token: string; namespace: string };
    expect(creds).toMatchObject({ box, token: TOKEN, namespace: 'dev.tester.' });
    const begin = seen.find((s) => s.url === '/api/apps/publishers/pair')!;
    expect(JSON.parse(begin.body.toString())).toMatchObject({ name: 'Tester', namespace_prefix: 'dev.tester.' });
    expect(begin.headers.authorization).toBeUndefined(); // pairing is unauthenticated on purpose
  });

  it('a wrong code is reported as the box error', async () => {
    await expect(run('pair', box, '--code', '000000')).rejects.toMatchObject({ status: 403, code: 'pairing_code_invalid' });
  });

  it('init → push signs the bundle and installs it with the token', async () => {
    // (no process.chdir: vitest runs tests in worker threads)
    await run('init', 'Hello', '--template', 'panel', '--dir', join(work, 'hello'));
    const out = await run('push', join(work, 'hello'));
    expect(out).toContain('installed dev.tester.hello 0.1.0');
    expect(out).toContain('developer build');
    const inst = seen.find((s) => s.url.startsWith('/api/apps/install'))!;
    expect(inst.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(inst.headers['content-type']).toBe('application/zip');
    expect(inst.url).toBe('/api/apps/install?app_id=dev.tester.hello');
    expect(verifyPlu(inst.body).ok).toBe(true);
  });

  it('push refuses a bundle that fails validation before touching the box', async () => {
    writeFileSync(join(work, 'hello', 'manifest.json'), JSON.stringify({ id: 'dev.tester.hello', name: 'x', version: '1', permissions: ['photos:all'] }));
    const before = seen.length;
    await expect(run('push', join(work, 'hello'))).rejects.toThrow(/error\(s\)/);
    expect(seen.length).toBe(before);
  });

  it.skipIf(!HAVE_GO)('push builds the service when the manifest names a binary that is not there', async () => {
    const dir = join(work, 'svcapp');
    await run('init', 'Svc', '--template', 'server-go', '--dir', dir);
    expect(existsSync(join(dir, 'svc'))).toBe(false);
    const out = await run('push', dir);
    expect(out).toContain('svc is not built yet');
    expect(out).toContain('installed dev.tester.svc');
    expect(existsSync(join(dir, 'svc'))).toBe(true);
    // The binary went into the bundle and passed the arm64 gate on the way.
    const inst = seen.filter((s) => s.url.startsWith('/api/apps/install')).pop()!;
    expect(verifyPlu(inst.body).ok).toBe(true);
    // Built once: a second push does not rebuild unless asked.
    const again = await run('push', dir);
    expect(again).not.toContain('not built yet');
  }, 180_000);

  it('logs, logs -f, status, restart, uninstall', async () => {
    expect(await run('logs', 'dev.tester.hello')).toBe('a\nb');
    expect(await run('logs', 'dev.tester.hello', '-f')).toBe('line one\nline two');
    expect(JSON.parse(await run('status', 'dev.tester.hello'))).toEqual({ state: 'ready', pid: 42 });
    expect(await run('restart', 'dev.tester.hello')).toContain('restarted');
    expect(await run('uninstall', 'dev.tester.hello')).toContain('uninstalled');
    expect(seen.filter((s) => s.url.startsWith('/api/apps/dev.tester.hello/')).every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});

describe('plum-dev publish against a fake store', () => {
  it('uploads the signed bundle with the publisher token and reports the outcome', async () => {
    const uploads: Array<{ auth?: string; contentType?: string; size: number }> = [];
    const storeSrv = createServer(async (req, res) => {
      const body = await read(req);
      if (req.url === '/v1/publisher/namespaces' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ namespaces: [{ prefix: 'dev.tester', method: 'auto' }], claims: [] }));
      }
      if (req.url === '/v1/publisher/versions' && req.method === 'POST') {
        uploads.push({ auth: req.headers.authorization, contentType: req.headers['content-type'], size: body.length });
        if (req.headers.authorization !== 'Bearer plum_pub_ok') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ detail: 'publisher token unknown or revoked' }));
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ app_id: 'dev.tester.hello', version: '0.1.0', status: 'in_review', created_app: true, publisher_kid: 'pub-x', countersign_kind: 'checks', rotated: false }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => storeSrv.listen(0, '127.0.0.1', r));
    const storeUrl = `http://127.0.0.1:${(storeSrv.address() as { port: number }).port}`;
    try {
      // A fresh, valid app (the earlier test broke work/hello's manifest on purpose).
      const dir = join(work, 'pub');
      await run('init', 'Hello', '--template', 'panel', '--dir', dir);
      // Without a token: refused before any request.
      delete process.env.PLUM_PUBLISHER_TOKEN;
      await expect(run('publish', dir, '--store', storeUrl)).rejects.toThrow(/no publisher token/);
      expect(uploads.length).toBe(0);
      // A box token is not a publisher token.
      await expect(run('publish', dir, '--store', storeUrl, '--token', 'plum_pat_nope')).rejects.toThrow(/plum_pub_/);
      // Saved via login, then used.
      await run('login', '--publisher-token', 'plum_pub_ok', '--store', storeUrl);
      const out = await run('publish', dir);
      expect(out).toContain('uploaded dev.tester.hello 0.1.0');
      expect(out).toContain('in_review');
      expect(uploads[0]!.auth).toBe('Bearer plum_pub_ok');
      expect(uploads[0]!.contentType).toMatch(/^multipart\/form-data/);
      expect(uploads[0]!.size).toBeGreaterThan(500);
      // A bad token surfaces the store's error, with its sentence.
      await expect(run('publish', dir, '--token', 'plum_pub_bad')).rejects.toMatchObject({ status: 401, origin: 'store', message: 'publisher token unknown or revoked' });
    } finally {
      storeSrv.close();
    }
  });
});

// The path a new developer takes, end to end, against a fake box and store that
// answer with the real shapes — the places it used to break (2026-11 audit).
describe('first app: namespace, icon and errors line up', () => {
  let storeUrl = '';
  let storeSrv: ReturnType<typeof createServer>;
  const parts: string[][] = [];

  beforeAll(async () => {
    storeSrv = createServer(async (req, res) => {
      const body = await read(req);
      const json = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/v1/publisher/namespaces') return json(200, { namespaces: [{ prefix: 'dev.tester', method: 'auto' }], claims: [] });
      if (req.url === '/v1/publisher/versions' && req.method === 'POST') {
        const names = [...body.toString('latin1').matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
        parts.push(names);
        // plum-store answers HTTPException(400, {"error", "detail"}) → {"detail": {...}}
        // (zip entry names are stored uncompressed, so a bundled icon.png shows in the bytes)
        if (!names.includes('icon') && !body.includes(Buffer.from('icon.png'))) {
          return json(400, { detail: { error: 'icon_required', detail: 'a new app needs an icon' } });
        }
        return json(201, { app_id: 'dev.tester.notes', version: '0.1.0', status: 'beta', created_app: true, publisher_kid: 'pub-x' });
      }
      json(404, { detail: 'Not Found' });
    });
    await new Promise<void>((r) => storeSrv.listen(0, '127.0.0.1', r));
    storeUrl = `http://127.0.0.1:${(storeSrv.address() as { port: number }).port}`;
    await run('login', '--publisher-token', 'plum_pub_ok', '--store', storeUrl);
  });

  afterAll(() => { storeSrv.close(); });

  it('login reads the store namespace, and init names the app under it with an icon', async () => {
    const creds = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')) as { store_namespaces?: string[] };
    expect(creds.store_namespaces).toEqual(['dev.tester']);
    const dir = join(work, 'notes');
    const out = await run('init', 'Notes', '--dir', dir);
    expect(out).not.toContain('a guess');
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { id: string; icon: string };
    expect(m).toMatchObject({ id: 'dev.tester.notes', icon: 'icon.png' });
    expect(existsSync(join(dir, 'icon.png'))).toBe(true);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('await plum.app.host()');
    expect(await run('validate', dir)).toMatch(/\nok$/); // no warnings: the icon is there and the store would take it
  });

  it('publish sends the bundle with its icon, and warns that it is the placeholder', async () => {
    const out = await run('publish', join(work, 'notes'), '--channel', 'public');
    expect(out).toContain('still the placeholder');
    expect(out).toContain('uploaded dev.tester.notes');
  });

  it('the store error comes through with its code and sentence, not "Bad Request"', async () => {
    const dir = join(work, 'noicon');
    await run('init', 'Noicon', '--dir', dir);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    delete m.icon;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    rmSync(join(dir, 'icon.png'));
    expect(await run('validate', dir)).toContain('no icon');
    await expect(run('publish', dir, '--channel', 'beta')).rejects.toMatchObject({ status: 400, code: 'icon_required', origin: 'store', message: 'a new app needs an icon' });
    // --icon supplies it as its own part.
    const out = await run('publish', dir, '--channel', 'beta', '--icon', join(work, 'notes', 'icon.png'));
    expect(out).toContain('uploaded');
    expect(parts.at(-1)).toContain('icon');
  });

  it('publish refuses an id outside your namespace before uploading', async () => {
    const dir = join(work, 'elsewhere');
    await run('init', 'Elsewhere', '--dir', dir, '--id', 'com.someone.elsewhere');
    const before = parts.length;
    await expect(run('publish', dir, '--channel', 'beta')).rejects.toThrow(/not under a namespace you own.*dev\.tester/s);
    expect(parts.length).toBe(before);
  });

  it('push refuses an id outside the paired namespace before touching the box', async () => {
    const before = seen.length;
    await expect(run('push', join(work, 'elsewhere'))).rejects.toThrow(/outside dev\.tester\./);
    expect(seen.length).toBe(before);
  });

  it('pairing again keeps the publisher token, its namespaces and the emulator session', async () => {
    const path = join(home, 'credentials.json');
    const c = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...c, emulator: { box: 'http://127.0.0.1:8080', token: 'plum_pat_emu' } }));
    await run('pair', box, '--code', '424242'); // no --namespace: the store's is used
    const begin = seen.filter((s) => s.url === '/api/apps/publishers/pair').pop()!;
    expect(JSON.parse(begin.body.toString())).toMatchObject({ namespace_prefix: 'dev.tester.' });
    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(after).toMatchObject({ publisher_token: 'plum_pub_ok', store_namespaces: ['dev.tester'], emulator: { token: 'plum_pat_emu' }, namespace: 'dev.tester.' });
  });

  it.skipIf(!HAVE_GO)('the server-go template runs on a laptop with -tags dev, and the box build refuses to', async () => {
    const dir = join(work, 'svclocal');
    await run('init', 'Svclocal', '--template', 'server-go', '--dir', dir);
    const srv = join(dir, 'server');
    const box = spawnSync('go', ['build', '-o', join(work, 'svc-box'), '.'], { cwd: srv, encoding: 'utf8' });
    expect(box.status, box.stderr).toBe(0);
    const noSock = spawnSync(join(work, 'svc-box'), [], { encoding: 'utf8', env: { ...process.env, PLUM_APP_SOCKET: '' } });
    expect(noSock.status).not.toBe(0);
    expect(noSock.stderr).toContain('go run -tags dev .');
    const dev = spawnSync('go', ['build', '-tags', 'dev', '-o', join(work, 'svc-dev'), '.'], { cwd: srv, encoding: 'utf8' });
    expect(dev.status, dev.stderr).toBe(0);
    const port = 18787 + Math.floor(Math.random() * 1000);
    const { spawn } = await import('node:child_process');
    const child = spawn(join(work, 'svc-dev'), [], { env: { ...process.env, PORT: String(port), PLUM_APP_SOCKET: '' }, stdio: 'ignore' });
    try {
      let body: unknown;
      for (let i = 0; i < 50 && body === undefined; i++) {
        try { body = await (await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { 'X-Plum-Username': 'devuser' } })).json(); } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      expect(body).toMatchObject({ username: 'devuser' });
    } finally {
      child.kill();
    }
  }, 180_000);
});
