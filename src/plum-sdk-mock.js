/*
 * plum-sdk-mock.js — Plum SDK v0.1 + v0.2 의 개발용 stub.
 *
 * 사용법:
 *   <script src="./plum-sdk-mock.js"></script>
 *   <script>
 *     const f = await window.plum.files.openPicker({ accept: '.docx' });
 *   </script>
 *
 * 동작:
 *   - openPicker        → 브라우저 native <input type=file> 다이얼로그
 *   - saveAsPicker      → 가짜 핸들 발급 (writeBytes 시 실제 동작)
 *   - readBytes         → 선택된 File 의 바이트
 *   - writeBytes        → 브라우저 다운로드 트리거 (실제 plum-box 에 안 감)
 *   - user.current      → dev user 고정값
 *   - app.host          → mock host 고정값
 *
 * 운영 (실 plum-box) 전환:
 *   <script src="/apps/runtime/plum-sdk.js"></script>
 * 한 줄로 교체. window.plum API 가 동일해서 앱 코드는 그대로 동작.
 */
(function (window) {
  'use strict';

  const handles = new Map();
  let nextId = 1;
  const newHandle = (name) => ({ id: 'mock-' + nextId++, name });

  window.plum = {
    files: {
      openPicker(opts = {}) {
        return new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          if (opts.multiple) input.multiple = true;
          if (opts.accept) {
            input.accept = Array.isArray(opts.accept)
              ? opts.accept.join(',')
              : opts.accept;
          }
          input.style.display = 'none';
          input.onchange = () => {
            const picked = Array.from(input.files || []);
            document.body.removeChild(input);
            if (picked.length === 0) return resolve(null);
            const toHandle = (file) => {
              const h = newHandle(file.name);
              handles.set(h.id, { kind: 'file', file });
              return h;
            };
            resolve(opts.multiple ? picked.map(toHandle) : toHandle(picked[0]));
          };
          // 사용자가 다이얼로그를 cancel 하면 onchange 가 안 불려서
          // 약간 비결정적. dev 용이니 큰 문제는 아님.
          document.body.appendChild(input);
          input.click();
        });
      },

      // mock 은 Drive "Open with" 실행 컨텍스트가 없다 — 항상 null.
      async launchFile() {
        return null;
      },

      // dev 에선 objectURL 로 대체 — <video src> 등 실환경과 동일하게 동작.
      url(handle) {
        const entry = handles.get(handle && handle.id);
        if (!entry || entry.kind !== 'file') {
          throw makeErr('FileNotFoundError', 'url: handle not found');
        }
        if (!entry.objectUrl) entry.objectUrl = URL.createObjectURL(entry.file);
        return entry.objectUrl;
      },

      async saveAsPicker(opts) {
        if (!opts || !opts.defaultName) {
          throw new Error('saveAsPicker: defaultName required');
        }
        const h = newHandle(opts.defaultName);
        handles.set(h.id, { kind: 'new', name: opts.defaultName });
        return h;
      },

      async readBytes(handle) {
        const entry = handles.get(handle.id);
        if (!entry) throw makeErr('FileNotFoundError', 'handle not found');
        if (entry.kind === 'new') return new Uint8Array(0);
        return new Uint8Array(await entry.file.arrayBuffer());
      },

      async writeBytes(handle, bytes) {
        const entry = handles.get(handle.id);
        if (!entry) throw makeErr('FileNotFoundError', 'handle not found');
        const name = entry.kind === 'file' ? entry.file.name : entry.name;
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      },

      async stat(handle) {
        const entry = handles.get(handle.id);
        if (!entry) throw makeErr('FileNotFoundError', 'handle not found');
        if (entry.kind === 'new') {
          return { name: entry.name, size: 0, mtime: Date.now() };
        }
        return {
          name: entry.file.name,
          size: entry.file.size,
          mtime: entry.file.lastModified,
        };
      },
    },

    user: {
      async current() {
        return {
          id: 'mock-user',
          username: 'devuser',
          email: 'dev@example.com',
          displayName: 'Dev User',
        };
      },
    },

    app: {
      async host() {
        return {
          deviceName: 'Plum Box (mock)',
          coreVersion: '0.0.0-mock',
          osVersion: '',
          apiLevel: 1,
        };
      },
      // v0.2 — the mock is a plain browser page: everything is the web fallback.
      async capabilities() {
        const n = navigator;
        return {
          sdk: '0.2',
          apiLevel: 1,
          native: null,
          ui: {
            share: n.share ? 'web' : 'none',
            clipboard: n.clipboard && n.clipboard.writeText ? 'web' : 'none',
            capture: 'web',
            haptic: n.vibrate ? 'web' : 'none',
            biometric: 'none',
            nav: 'none',
          },
        };
      },
      async open(appId) { console.log('[plum mock] app.open(' + appId + ') — no shell here'); },
      theme() { return matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; },
      onThemeChange() { return function () {}; },
      locale() { return navigator.language || 'en'; },
      onLocaleChange() { return function () {}; },
      setDocumentState() {},
    },

    // v0.2 — plum.ui with the same web fallbacks the runtime uses in a browser.
    ui: {
      async share(opts) {
        const o = opts || {};
        if (!navigator.share) throw makeErr('UnsupportedError', 'sharing is not available in this browser');
        const data = {};
        if (o.text) data.text = String(o.text);
        if (o.url) data.url = String(o.url);
        try { await navigator.share(data); } catch (e) { if (e && e.name === 'AbortError') throw makeErr('CancelledError', 'share cancelled'); throw e; }
      },
      clipboard: {
        async write(text) { if (!navigator.clipboard) throw makeErr('UnsupportedError', 'no clipboard'); await navigator.clipboard.writeText(String(text)); },
        async read() { if (!navigator.clipboard) throw makeErr('UnsupportedError', 'no clipboard'); return navigator.clipboard.readText(); },
      },
      async capture() {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment');
        return new Promise((resolve, reject) => {
          input.addEventListener('change', () => {
            const f = input.files && input.files[0];
            if (!f) return reject(makeErr('CancelledError', 'capture cancelled'));
            const h = newHandle(f.name); handles.set(h.id, f); resolve(h);
          });
          input.click();
        });
      },
      async haptic(style) { if (navigator.vibrate) navigator.vibrate(style === 'heavy' ? 30 : 10); },
      async openExternal(url) { window.open(String(url), '_blank', 'noopener'); },
      biometric: { async confirm() { throw makeErr('UnsupportedError', 'no biometrics in the mock'); } },
      nav: { setBackHandler() { return false; }, close() { console.log('[plum mock] nav.close()'); } },
      inShell() { return false; },
      menu: { set() { return false; }, clear() { return false; } },
    },

    // v0.2 — entitlements: no store in the mock. Override window.plum.entitlement.get
    // in your dev page to simulate a purchase.
    entitlement: {
      async get() { return { skus: [], refreshed_at: '', stale: true }; },
      async refresh() { return 0; },
    },

    // v0.2 — photos.pick: the same file dialog restricted to images.
    photos: {
      async pick(opts) {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.multiple = !!(opts && opts.multiple);
        return new Promise((resolve) => {
          input.addEventListener('change', () => {
            const list = Array.from(input.files || []).map((f) => { const h = newHandle(f.name); handles.set(h.id, f); return h; });
            resolve(input.multiple ? (list.length ? list : null) : (list[0] || null));
          });
          input.click();
        });
      },
    },

    events: { subscribe() { return function () {}; } },

    // mock 에는 실제 server .plu 백엔드가 없다 — surface 만 제공. fetch 는 명확히
    // 거부하니, 서버 .plu 를 개발할 땐 자기 서비스를 띄우거나 이 메서드를 스텁할 것.
    service: {
      url(path) {
        let p = String(path == null ? '/' : path);
        if (p.charAt(0) !== '/') p = '/' + p;
        return '/apps/mock/svc' + p;
      },
      async fetch(path) {
        throw makeErr(
          'mock_no_server',
          'plum.service.fetch(' + JSON.stringify(path) +
            '): mock 에는 server .plu 백엔드가 없습니다. 실제 서비스를 띄우거나 plum.service 를 스텁하세요.'
        );
      },
    },
  };

  function makeErr(code, msg) {
    const e = new Error(msg);
    e.code = code;
    return e;
  }
})(window);
