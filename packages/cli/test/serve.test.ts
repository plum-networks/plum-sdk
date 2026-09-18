import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startServe } from '../src/serve.js';

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
});
