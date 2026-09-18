// `plum-dev init <name> --template panel|server-go`: a runnable starting
// point that already passes `plum-dev validate`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Template = 'panel' | 'server-go';

function indexHtml(name: string, withService: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name}</title>
  <!-- On the box this resolves to the real runtime; \`plum-dev serve\` answers it with the mock. -->
  <script src="/apps/runtime/plum-sdk.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; color: #1f1f1f; background: #fafafa; }
    pre { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; overflow: auto; }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <p id="who">…</p>
  <pre id="out"></pre>
  <script>
    (async () => {
      const me = await plum.user.current();
      document.getElementById('who').textContent = 'Hello, ' + (me.username || me.name || 'there') + '!';
${withService ? `      const r = await plum.service.fetch('/whoami');
      document.getElementById('out').textContent = JSON.stringify(await r.json(), null, 2);` : `      document.getElementById('out').textContent = JSON.stringify(plum.app.host(), null, 2);`}
    })().catch((e) => { document.getElementById('out').textContent = String(e); });
  </script>
</body>
</html>
`;
}

const SERVER_MAIN_GO = `// Box-side service for this app. Core launches one copy per (user, app) under
// the app's own uid, hands it a unix socket in PLUM_APP_SOCKET, and proxies
// /apps/<id>/svc/* to it with the caller's identity in X-Plum-* headers.
package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
)

func main() {
	log.SetFlags(0) // core timestamps every line for you

	sock := os.Getenv("PLUM_APP_SOCKET")
	if sock == "" {
		log.Fatal("PLUM_APP_SOCKET not set: this binary is started by the Plum supervisor")
	}
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		log.Fatalf("listen %s: %v", sock, err)
	}
	defer ln.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/whoami", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"userId":   r.Header.Get("X-Plum-User-Id"),
			"username": r.Header.Get("X-Plum-Username"),
			"appId":    r.Header.Get("X-Plum-App-Id"),
			"perms":    r.Header.Get("X-Plum-Perms"),
			"dataDir":  os.Getenv("PLUM_APP_DATA_DIR"),
			"version":  os.Getenv("PLUM_APP_VERSION"),
		})
	})

	log.Printf("listening on %s", sock)
	if err := (&http.Server{Handler: mux}).Serve(ln); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
`;

const SERVER_DEV_GO = `//go:build dev

// \`go run -tags dev ./server\` serves the same handlers on TCP so
// \`plum-dev serve --service http://127.0.0.1:8080\` can reach them on a laptop.
package main
`;

const BUILD_SH = `#!/usr/bin/env bash
# Cross-compiles the service for the box (arm64) and writes ./svc.
# Pure-Go services need no cross toolchain.
set -euo pipefail
cd "$(dirname "$0")"
( cd server && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o ../svc . )
echo "built svc ($(du -h svc | cut -f1)); next: plum-dev push"
`;

export function scaffold(dir: string, name: string, id: string, template: Template): string[] {
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const put = (rel: string, content: string, mode = 0o644) => {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, { mode });
    written.push(rel);
  };
  const manifest: Record<string, unknown> = { id, name, version: '0.1.0', entry: 'index.html', description: `${name} for Plum Box`, mobile: true };
  if (template === 'server-go') {
    manifest.permissions = ['service:call'];
    manifest.server = { bin: 'svc', healthPath: '/healthz', limits: { memory: '128M', cpu: 50, pids: 32 } };
  } else {
    manifest.permissions = ['user:profile'];
  }
  put('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  put('index.html', indexHtml(name, template === 'server-go'));
  put('.plumignore', 'README.md\nserver/\nbuild.sh\n');
  put('README.md', `# ${name}\n\n- \`plum-dev serve\` runs the panel on your laptop with the mock SDK.\n${template === 'server-go' ? '- `./build.sh` cross-compiles the service, then\n' : ''}- \`plum-dev push\` signs and installs it on your paired box.\n`);
  if (template === 'server-go') {
    put('server/go.mod', `module ${id.replace(/[^a-z0-9.\-]/g, '-')}/server\n\ngo 1.22\n`);
    put('server/main.go', SERVER_MAIN_GO);
    put('server/dev.go', SERVER_DEV_GO);
    put('build.sh', BUILD_SH, 0o755);
  }
  return written;
}
