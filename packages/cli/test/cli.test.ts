// Drives the real command entry points against a fake box that answers with
// the exact shapes plum-box-core uses (internal/apps/{publishers,install_direct,logs}.go).
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('logs, logs -f, status, restart, uninstall', async () => {
    expect(await run('logs', 'dev.tester.hello')).toBe('a\nb');
    expect(await run('logs', 'dev.tester.hello', '-f')).toBe('line one\nline two');
    expect(JSON.parse(await run('status', 'dev.tester.hello'))).toEqual({ state: 'ready', pid: 42 });
    expect(await run('restart', 'dev.tester.hello')).toContain('restarted');
    expect(await run('uninstall', 'dev.tester.hello')).toContain('uninstalled');
    expect(seen.filter((s) => s.url.startsWith('/api/apps/dev.tester.hello/')).every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});
