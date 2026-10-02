import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside, isLoopbackHost, startServe } from '../src/serve.js';

/** GET with a raw path and Host header, as a browser or a script could send them. */
function rawGet(base: string, path: string, host?: string): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((resolveP, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serve', () => {
  it('serves the panel with the prelude, the mock SDK, and proxies svc calls with dev identity headers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plumserve-'));
    writeFileSync(join(dir, 'index.html'), '<html><head><script src="/apps/runtime/plum-sdk.js"></script></head><body>hi</body></html>');
    writeFileSync(join(dir, 'app.css'), 'body{}');

    const seen: Record<string, string | undefined> = {};
    const svc = createServer((req, res) => {
      seen.path = req.url;
      seen.user = req.headers['x-plum-user-id'] as string;
      seen.app = req.headers['x-plum-app-id'] as string;
      seen.perms = req.headers['x-plum-perms'] as string;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => svc.listen(0, '127.0.0.1', r));
    const svcPort = (svc.address() as { port: number }).port;

    const { url, close } = await startServe({ dir, appId: 'dev.t.app', perms: ['service:call'], port: 0, service: `http://127.0.0.1:${svcPort}` });
    try {
      const html = await (await fetch(url)).text();
      expect(html).toContain('window.__PLUM_APP__=');
      expect(html).toContain('"id":"dev.t.app"');
      const sdk = await fetch(new URL('/apps/runtime/plum-sdk.js', url));
      expect(sdk.status).toBe(200);
      expect((await sdk.text())).toContain('plum');
      const css = await fetch(url + 'app.css');
      expect(css.headers.get('content-type')).toBe('text/css');
      const nf = await fetch(url + '../../etc/passwd');
      expect(nf.status).toBe(404);
      const r = await fetch(url + 'svc/whoami?x=1', { method: 'POST', body: 'b' });
      expect(await r.json()).toEqual({ ok: true });
      expect(seen.path).toBe('/whoami?x=1');
      expect(seen.user).toBe('dev-user');
      expect(seen.app).toBe('dev.t.app');
      expect(seen.perms).toBe('["service:call"]');
    } finally {
      close();
      svc.close();
    }
  });

  it('serves nothing outside the app dir: no same-prefix sibling, no link out (APPS-004)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'plumserve-'));
    const dir = join(parent, 'demo');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), '<html><head></head><body>hi</body></html>');
    writeFileSync(join(dir, 'ok.txt'), 'ok');
    mkdirSync(join(parent, 'demo-backup'));
    writeFileSync(join(parent, 'demo-backup', 'secret.txt'), 'sibling secret');
    writeFileSync(join(parent, 'outside.txt'), 'parent secret');
    const links = process.platform !== 'win32';
    if (links) {
      symlinkSync(join(parent, 'outside.txt'), join(dir, 'link.txt'));
      symlinkSync(join(parent, 'demo-backup'), join(dir, 'linkdir'));
      symlinkSync(join(dir, 'ok.txt'), join(dir, 'alias.txt')); // a link that stays inside is fine
    }

    const { url, close } = await startServe({ dir, appId: 'dev.t.app', perms: [], port: 0 });
    const path = new URL(url).pathname;
    try {
      expect((await rawGet(url, path + '..%2Fdemo-backup%2Fsecret.txt')).status).toBe(404);
      expect((await rawGet(url, path + '..%2Foutside.txt')).status).toBe(404);
      expect((await rawGet(url, path + '%2E%2E%2Fdemo-backup/secret.txt')).status).toBe(404);
      if (links) {
        expect((await rawGet(url, path + 'link.txt')).status).toBe(404);
        expect((await rawGet(url, path + 'linkdir/secret.txt')).status).toBe(404);
        expect(await rawGet(url, path + 'alias.txt')).toEqual({ status: 200, body: 'ok' });
      }
      // A malformed escape is a 400 — and the server is still up afterwards.
      expect((await rawGet(url, path + '%E0%A4%A')).status).toBe(400);
      expect(await rawGet(url, path + 'ok.txt')).toEqual({ status: 200, body: 'ok' });
    } finally {
      close();
    }
  });

  it('answers only to a loopback Host, so a DNS-rebinding page cannot read the app (APPS-004)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plumserve-'));
    writeFileSync(join(dir, 'ok.txt'), 'ok');
    const { url, close } = await startServe({ dir, appId: 'dev.t.app', perms: [], port: 0 });
    const path = new URL(url).pathname + 'ok.txt';
    const port = new URL(url).port;
    try {
      expect((await rawGet(url, path, `attacker.example:${port}`)).status).toBe(403);
      expect((await rawGet(url, path, `localhost:${port}`)).status).toBe(200);
      expect((await rawGet(url, path, `127.0.0.1:${port}`)).status).toBe(200);
    } finally {
      close();
    }
  });

  it('isInside compares path segments, not string prefixes', () => {
    expect(isInside('/work/demo', '/work/demo')).toBe(true);
    expect(isInside('/work/demo', '/work/demo/a/b.txt')).toBe(true);
    expect(isInside('/work/demo', '/work/demo/..hidden')).toBe(true);
    expect(isInside('/work/demo', '/work/demo-backup/secret.txt')).toBe(false);
    expect(isInside('/work/demo', '/work/demo2')).toBe(false);
    expect(isInside('/work/demo', '/work')).toBe(false);
    expect(isInside('/work/demo', '/etc/passwd')).toBe(false);
  });

  it('isLoopbackHost', () => {
    for (const h of ['localhost', 'localhost:4040', '127.0.0.1:4040', '127.1.2.3', '[::1]:4040', 'app.localhost:4040']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of [undefined, '', 'attacker.example', 'attacker.example:4040', '127.0.0.1.attacker.example', 'localhost.attacker.example', '10.0.0.5:4040']) {
      expect(isLoopbackHost(h), String(h)).toBe(false);
    }
  });
});
