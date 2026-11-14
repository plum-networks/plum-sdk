// `plum-dev serve`: a local server for a panel-only app (or a panel plus a
// service running on the laptop). Serves the app dir like the box does under
// /apps/<id>/, injects the mock SDK when the page asks for plum-sdk.js, and
// proxies /apps/<id>/svc/* to --service with the identity headers core would
// set. Nothing here touches a box.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json',
};

/** Who the mock SDK says is signed in (src/plum-sdk-mock.js, user.current). */
export const MOCK_USER = { id: 'mock-user', username: 'devuser' } as const;

export interface ServeOptions {
  dir: string;
  appId: string;
  perms: string[];
  port: number;
  service?: string; // http://localhost:8080
}

function mockSdkPath(): string {
  // dist/plum-sdk-mock.js next to the built CLI; in the source tree, the repo's src copy.
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const c of [join(here, 'plum-sdk-mock.js'), join(here, '..', '..', '..', 'src', 'plum-sdk-mock.js')]) {
    if (existsSync(c)) return c;
  }
  throw new Error('plum-sdk-mock.js not found next to the CLI');
}

export function startServe(o: ServeOptions): Promise<{ url: string; close: () => void }> {
  const root = resolve(o.dir);
  const prefix = `/apps/${o.appId}/`;
  // `service` tells the mock SDK that /apps/<id>/svc/* reaches a real service here.
  const prelude = `<script>window.__PLUM_APP__=${JSON.stringify({ id: o.appId, perms: o.perms, version: 'dev', token: 'dev', service: !!o.service })};</script>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/apps' || url.pathname === '/apps/') {
      res.writeHead(302, { Location: prefix });
      return res.end();
    }
    if (url.pathname === '/apps/runtime/plum-sdk.js' || url.pathname.endsWith('/plum-sdk-mock.js')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return createReadStream(mockSdkPath()).pipe(res);
    }
    if (o.service && url.pathname.startsWith(prefix + 'svc')) return proxy(req, res, o, url.pathname.slice((prefix + 'svc').length) + url.search);
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404);
      return res.end('not found');
    }
    let rel = decodeURIComponent(url.pathname.slice(prefix.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(root, rel));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Cache-Control', 'no-store');
    if (type.startsWith('text/html')) {
      let html = readFileSync(file, 'utf8');
      // The box rewrites mock/relative SDK tags to its runtime; here the
      // runtime IS the mock, so both spellings work.
      html = html.replace(/<head>/i, '<head>' + prelude);
      res.writeHead(200, { 'Content-Type': type });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': type });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveP, reject) => {
    server.on('error', reject);
    server.listen(o.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : o.port;
      resolveP({ url: `http://127.0.0.1:${port}${prefix}`, close: () => server.close() });
    });
  });
}

function proxy(req: IncomingMessage, res: ServerResponse, o: ServeOptions, rest: string) {
  const target = new URL(o.service!);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string' && !k.toLowerCase().startsWith('x-plum-') && k.toLowerCase() !== 'cookie') headers[k] = v;
  }
  // The same identity the mock SDK's plum.user.current() reports, and the headers
  // core always sets (X-Plum-Entitlements is present even when empty).
  Object.assign(headers, {
    'X-Plum-User-Id': MOCK_USER.id, 'X-Plum-Username': MOCK_USER.username, 'X-Plum-App-Id': o.appId, 'X-Plum-Perms': JSON.stringify(o.perms),
    'X-Plum-Entitlements': '',
    host: target.host,
  });
  const up = httpRequest({ host: target.hostname, port: target.port || 80, method: req.method, path: rest || '/', headers }, (r2) => {
    res.writeHead(r2.statusCode || 502, r2.headers);
    r2.pipe(res);
  });
  up.on('error', () => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'app backend unavailable (is --service running?)' }));
  });
  req.pipe(up);
}
