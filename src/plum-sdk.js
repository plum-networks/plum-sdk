/*
 * plum-sdk.js — Plum SDK v0.1 의 production 런타임.
 *
 * 박스가 /apps/runtime/plum-sdk.js 한 파일로 서빙. 앱 index.html 이
 *   <script src="/apps/runtime/plum-sdk.js"></script>
 * 한 줄로 import 하면 window.plum 즉시 사용 가능.
 *
 * mock (plum-sdk-mock.js) 과 surface 동일. 차이:
 *   - openPicker      → 박스의 drive/photos 트리에서 고르는 모달
 *   - readBytes       → /api/apps/handle/<id>/read (박스가 실제 바이트 보냄)
 *   - writeBytes      → /api/apps/handle/<id>/write (박스 파일시스템에 저장)
 *   - user.current    → /api/auth/me (현재 로그인 사용자)
 *   - app.host        → /api/auth/status (박스 디바이스 정보)
 *
 * 권한:
 *   박스가 entry HTML 앞에 prelude `<script>window.__PLUM_APP__={id,perms,version}</script>`
 *   를 inject. 이 SDK 가 그걸 읽어 manifest 에 선언된 권한만 호출 허용
 *   (PermissionDeniedError throw). v0.1 은 client-side 만 — third-party
 *   받기 전 서버측 enforcement 필요 (PLUM_SDK_v0.1.md "host-side
 *   enforcement deferred" 참고).
 */
(function (window) {
  'use strict';

  // --- 에러 클래스 ---
  function makeErrorClass(name) {
    function E(message) {
      const e = new Error(message);
      e.name = name;
      e.code = name;
      Object.setPrototypeOf(e, E.prototype);
      return e;
    }
    E.prototype = Object.create(Error.prototype);
    E.prototype.constructor = E;
    return E;
  }
  const PermissionDeniedError = makeErrorClass('PermissionDeniedError');
  const FileNotFoundError = makeErrorClass('FileNotFoundError');
  const QuotaExceededError = makeErrorClass('QuotaExceededError');
  const NetworkError = makeErrorClass('NetworkError');

  function errorFromResponse(status, body) {
    const code = body && typeof body === 'object' && body.error
      ? String(body.error) : '';
    const msg = body && typeof body === 'object' && body.message
      ? String(body.message) : 'HTTP ' + status;
    switch (code) {
      case 'permission_denied': return new PermissionDeniedError(msg);
      case 'not_found':
      case 'handle_expired': return new FileNotFoundError(msg);
      case 'quota_exceeded': return new QuotaExceededError(msg);
      default: return new NetworkError(msg);
    }
  }

  // 현재 앱 id. prelude(`window.__PLUM_APP__`) 우선, 없으면 /apps/<id>/ 경로에서.
  function appId() {
    const ctx = window.__PLUM_APP__;
    if (ctx && ctx.id) return String(ctx.id);
    const m = String(window.location.pathname).match(/^\/apps\/([^/]+)\//);
    return m ? m[1] : '';
  }

  // --- 권한 체크 (prelude `window.__PLUM_APP__` 기준) ---
  function requirePerm(name) {
    const ctx = window.__PLUM_APP__;
    if (!ctx) return; // dev: prelude 없으면 통과 (mock 호환).
    if (!ctx.perms || ctx.perms.indexOf(name) === -1) {
      throw new PermissionDeniedError(
        'Permission "' + name + '" not declared in manifest for app "' +
        (ctx.id || 'unknown') + '"'
      );
    }
  }

  // --- HTTP helpers ---
  async function jsonFetch(input, init) {
    let r;
    try {
      r = await fetch(input, Object.assign({ credentials: 'same-origin' }, init || {}));
    } catch (e) {
      throw new NetworkError('fetch failed: ' + (e && e.message ? e.message : String(e)));
    }
    if (!r.ok) {
      let body = null;
      try { body = await r.json(); } catch (_) {}
      throw errorFromResponse(r.status, body);
    }
    return r.json();
  }

  // --- picker-modal (drive / photos) ---
  const STYLES = `
.plum-picker-root {
  position: fixed; inset: 0; background: rgba(0,0,0,0.45);
  display: none; align-items: center; justify-content: center;
  z-index: 2147483000; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}
.plum-picker-card {
  background: white; width: min(560px, 92vw); max-height: 80vh;
  display: flex; flex-direction: column;
  border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.25);
  overflow: hidden;
}
.plum-picker-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid #eee;
}
.plum-picker-header h2 { font-size: 16px; margin: 0; }
.plum-picker-close {
  background: transparent; border: 0; font-size: 22px; cursor: pointer;
  color: #666;
}
.plum-picker-tabs { display: flex; padding: 8px 12px; gap: 8px; border-bottom: 1px solid #eee; }
.plum-picker-tab {
  padding: 6px 14px; border-radius: 999px; border: 1px solid #ddd;
  background: white; cursor: pointer; font-size: 13px;
}
.plum-picker-tab.active { background: #111; color: white; border-color: #111; }
.plum-picker-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.plum-picker-row {
  padding: 10px 18px; cursor: pointer; font-size: 14px;
  border-bottom: 1px solid #f5f5f5;
}
.plum-picker-row:hover { background: #f9f9f9; }
.plum-picker-pathhint { padding: 8px 16px; font-size: 12px; color: #999; border-top: 1px solid #eee; }
.plum-picker-empty, .plum-picker-loading { padding: 18px; color: #999; text-align: center; font-size: 14px; }
.plum-picker-error { padding: 18px; color: #c33; text-align: center; font-size: 14px; }

.plum-picker-saveform { padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.plum-picker-label { font-size: 12px; color: #666; }
.plum-picker-input {
  padding: 8px 10px; font-size: 14px; border: 1px solid #ddd; border-radius: 6px;
}
.plum-picker-note { font-size: 12px; color: #999; }
.plum-picker-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.plum-picker-btn {
  padding: 8px 14px; border-radius: 6px; border: 1px solid #ddd; background: white;
  font-size: 13px; cursor: pointer;
}
.plum-picker-btn-primary { background: #111; color: white; border-color: #111; }
`;

  function injectStyles() {
    if (document.getElementById('plum-picker-styles')) return;
    const s = document.createElement('style');
    s.id = 'plum-picker-styles';
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  function ensureRoot() {
    let root = document.getElementById('plum-picker-root');
    if (root) return root;
    injectStyles();
    root = document.createElement('div');
    root.id = 'plum-picker-root';
    root.className = 'plum-picker-root';
    root.style.display = 'none';
    document.body.appendChild(root);
    return root;
  }

  function el(tag, opts) {
    const e = document.createElement(tag);
    opts = opts || {};
    if (opts.text !== undefined) e.textContent = opts.text;
    if (opts.class !== undefined) e.className = opts.class;
    return e;
  }

  function parentPath(p) {
    if (!p || p === '/' || p === '') return '/';
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    if (idx <= 0) return '/';
    return trimmed.slice(0, idx);
  }

  function joinPath(base, name) {
    if (!base || base === '/') return '/' + name;
    return base.replace(/\/+$/, '') + '/' + name;
  }

  function buildFilter(accept) {
    if (!accept) return function () { return true; };
    const arr = Array.isArray(accept) ? accept : [accept];
    const exts = arr.map(function (s) { return String(s).trim().toLowerCase(); })
                    .filter(function (s) { return s.startsWith('.'); });
    if (exts.length === 0) return function () { return true; };
    return function (name) {
      const lower = String(name).toLowerCase();
      for (let i = 0; i < exts.length; i++) {
        if (lower.endsWith(exts[i])) return true;
      }
      return false;
    };
  }

  async function fetchDrive(path) {
    const r = await fetch(
      '/api/drive/list?path=' + encodeURIComponent(path === '' ? '/' : path),
      { credentials: 'same-origin' }
    );
    if (!r.ok) throw new NetworkError('drive/list ' + r.status);
    return r.json();
  }

  async function fetchPhotos() {
    const r = await fetch('/api/photos/list', { credentials: 'same-origin' });
    if (!r.ok) throw new NetworkError('photos/list ' + r.status);
    const data = await r.json();
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.photos)) return data.photos;
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  }

  function showOpenPicker(accept) {
    return new Promise(function (resolve, reject) {
      const filter = buildFilter(accept);
      const root = ensureRoot();
      root.innerHTML = '';
      root.style.display = 'flex';

      const card = el('div', { class: 'plum-picker-card' });
      const header = el('div', { class: 'plum-picker-header' });
      header.appendChild(el('h2', { text: 'Pick a file' }));
      const closeBtn = el('button', { text: '×', class: 'plum-picker-close' });
      closeBtn.addEventListener('click', function () { hide(); resolve(null); });
      header.appendChild(closeBtn);
      card.appendChild(header);

      const tabs = el('div', { class: 'plum-picker-tabs' });
      const driveTab = el('button', { text: 'Drive', class: 'plum-picker-tab active' });
      const photosTab = el('button', { text: 'Photos', class: 'plum-picker-tab' });
      tabs.appendChild(driveTab);
      tabs.appendChild(photosTab);
      card.appendChild(tabs);

      const list = el('div', { class: 'plum-picker-list' });
      card.appendChild(list);

      const pathHint = el('div', { class: 'plum-picker-pathhint', text: '/' });
      card.appendChild(pathHint);

      root.appendChild(card);

      let currentTab = 'drive';
      let currentPath = '/';

      function hide() {
        root.style.display = 'none';
        root.innerHTML = '';
      }

      function renderDrive(entries) {
        list.innerHTML = '';
        pathHint.textContent = currentPath;

        if (currentPath !== '/' && currentPath !== '') {
          const upRow = el('div', { class: 'plum-picker-row', text: '⬆ ..' });
          upRow.addEventListener('click', function () {
            currentPath = parentPath(currentPath);
            refresh();
          });
          list.appendChild(upRow);
        }

        const dirs = entries.filter(function (e) { return e.isDir; });
        const files = entries.filter(function (e) { return !e.isDir && filter(e.name); });

        dirs.forEach(function (d) {
          const row = el('div', { class: 'plum-picker-row plum-picker-dir' });
          row.textContent = '📁 ' + d.name;
          row.addEventListener('click', function () {
            currentPath = joinPath(currentPath, d.name);
            refresh();
          });
          list.appendChild(row);
        });
        files.forEach(function (f) {
          const row = el('div', { class: 'plum-picker-row plum-picker-file' });
          row.textContent = '📄 ' + f.name;
          row.addEventListener('click', function () {
            hide();
            resolve({
              kind: 'drive', path: f.path, name: f.name,
              size: f.size, mtime: new Date(f.modTime).getTime()
            });
          });
          list.appendChild(row);
        });
        if (dirs.length === 0 && files.length === 0) {
          list.appendChild(el('div', { text: 'Empty', class: 'plum-picker-empty' }));
        }
      }

      function renderPhotos(entries) {
        list.innerHTML = '';
        pathHint.textContent = '(all photos)';
        const filtered = entries.filter(function (p) { return filter(p.name); });
        if (filtered.length === 0) {
          list.appendChild(el('div', { text: 'No photos match', class: 'plum-picker-empty' }));
          return;
        }
        filtered.forEach(function (p) {
          const row = el('div', { class: 'plum-picker-row plum-picker-file' });
          row.textContent = '🖼 ' + p.name;
          row.addEventListener('click', function () {
            hide();
            resolve({
              kind: 'photo', path: p.relPath || p.name, name: p.name,
              size: typeof p.size === 'number' ? p.size : 0,
              mtime: typeof p.mtime === 'number' ? p.mtime : 0
            });
          });
          list.appendChild(row);
        });
      }

      async function refresh() {
        list.innerHTML = '';
        list.appendChild(el('div', { text: 'Loading…', class: 'plum-picker-loading' }));
        try {
          if (currentTab === 'drive') {
            const entries = await fetchDrive(currentPath);
            renderDrive(entries);
          } else {
            const entries = await fetchPhotos();
            renderPhotos(entries);
          }
        } catch (err) {
          list.innerHTML = '';
          list.appendChild(el('div', {
            text: 'Failed to load: ' + (err && err.message ? err.message : String(err)),
            class: 'plum-picker-error'
          }));
        }
      }

      driveTab.addEventListener('click', function () {
        currentTab = 'drive';
        driveTab.classList.add('active');
        photosTab.classList.remove('active');
        refresh();
      });
      photosTab.addEventListener('click', function () {
        currentTab = 'photo';
        photosTab.classList.add('active');
        driveTab.classList.remove('active');
        refresh();
      });

      root.addEventListener('click', function (e) {
        if (e.target === root) {
          hide();
          resolve(null);
        }
      });

      refresh().catch(reject);
    });
  }

  function showSaveAsPicker(defaultName) {
    return new Promise(function (resolve) {
      const root = ensureRoot();
      root.innerHTML = '';
      root.style.display = 'flex';

      const card = el('div', { class: 'plum-picker-card' });
      const header = el('div', { class: 'plum-picker-header' });
      header.appendChild(el('h2', { text: 'Save as' }));
      const closeBtn = el('button', { text: '×', class: 'plum-picker-close' });
      closeBtn.addEventListener('click', function () { hide(); resolve(null); });
      header.appendChild(closeBtn);
      card.appendChild(header);

      const form = el('div', { class: 'plum-picker-saveform' });
      form.appendChild(el('label', { text: 'File name', class: 'plum-picker-label' }));
      const input = el('input', { class: 'plum-picker-input' });
      input.type = 'text';
      input.value = defaultName;
      form.appendChild(input);

      form.appendChild(el('div', {
        class: 'plum-picker-note',
        text: 'File will be saved under Drive › Apps › current app.'
      }));

      const actions = el('div', { class: 'plum-picker-actions' });
      const cancel = el('button', { text: 'Cancel', class: 'plum-picker-btn' });
      const save = el('button', {
        text: 'Save',
        class: 'plum-picker-btn plum-picker-btn-primary'
      });
      actions.appendChild(cancel);
      actions.appendChild(save);
      form.appendChild(actions);
      card.appendChild(form);

      cancel.addEventListener('click', function () { hide(); resolve(null); });
      save.addEventListener('click', function () {
        const name = (input.value || '').trim() || defaultName;
        hide();
        resolve({ defaultName: name });
      });

      root.appendChild(card);

      function hide() {
        root.style.display = 'none';
        root.innerHTML = '';
      }
    });
  }

  // --- plum.files ---
  const files = {
    async openPicker(opts) {
      const picked = await showOpenPicker(opts && opts.accept);
      if (!picked) return null;
      const r = await fetch('/api/apps/picker/grant', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: picked.kind, path: picked.path })
      });
      if (!r.ok) {
        let body = null;
        try { body = await r.json(); } catch (_) {}
        throw errorFromResponse(r.status, body);
      }
      const grant = await r.json();
      return { id: grant.id, name: grant.name };
    },

    async saveAsPicker(opts) {
      if (!opts || !opts.defaultName) {
        throw new Error('saveAsPicker: defaultName required');
      }
      const result = await showSaveAsPicker(opts.defaultName);
      if (!result) return null;
      const r = await fetch('/api/apps/picker/grant', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'new', name: result.defaultName })
      });
      if (!r.ok) {
        let body = null;
        try { body = await r.json(); } catch (_) {}
        throw errorFromResponse(r.status, body);
      }
      const grant = await r.json();
      return { id: grant.id, name: grant.name };
    },

    async readBytes(handle) {
      requirePerm('files:read');
      let r;
      try {
        r = await fetch(
          '/api/apps/handle/' + encodeURIComponent(handle.id) + '/read',
          { credentials: 'same-origin' }
        );
      } catch (e) {
        throw new NetworkError('read fetch failed: ' + (e && e.message ? e.message : String(e)));
      }
      if (r.status === 404) throw new FileNotFoundError('handle not found or expired');
      if (!r.ok) {
        let body = null;
        try { body = await r.json(); } catch (_) {}
        throw errorFromResponse(r.status, body);
      }
      const buf = await r.arrayBuffer();
      return new Uint8Array(buf);
    },

    async writeBytes(handle, bytes) {
      requirePerm('files:write');
      let r;
      try {
        r = await fetch(
          '/api/apps/handle/' + encodeURIComponent(handle.id) + '/write',
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: bytes
          }
        );
      } catch (e) {
        throw new NetworkError('write fetch failed: ' + (e && e.message ? e.message : String(e)));
      }
      if (r.status === 404) throw new FileNotFoundError('handle not found or expired');
      if (r.status === 413 || r.status === 507) {
        let msg = 'Storage quota exceeded';
        try {
          const body = await r.json();
          if (body && body.message) msg = String(body.message);
        } catch (_) {}
        throw new QuotaExceededError(msg);
      }
      if (!r.ok) {
        let body = null;
        try { body = await r.json(); } catch (_) {}
        throw errorFromResponse(r.status, body);
      }
    },

    async stat(handle) {
      const r = await fetch(
        '/api/apps/handle/' + encodeURIComponent(handle.id),
        { credentials: 'same-origin' }
      );
      if (r.status === 404) throw new FileNotFoundError('handle not found or expired');
      if (!r.ok) {
        let body = null;
        try { body = await r.json(); } catch (_) {}
        throw errorFromResponse(r.status, body);
      }
      const j = await r.json();
      return {
        name: String(j.name != null ? j.name : handle.name),
        size: Number(j.size || 0),
        mtime: Number(j.mtime || 0)
      };
    }
  };

  // --- plum.user ---
  const user = {
    async current() {
      requirePerm('user:profile');
      const j = await jsonFetch('/api/auth/me');
      const u = j && (j.user || j);
      return {
        id: String(u.id || ''),
        username: String(u.username || ''),
        email: String(u.email || ''),
        displayName: String(u.display_name || u.displayName || u.username || '')
      };
    }
  };

  // --- plum.app ---
  const app = {
    async host() {
      const j = await jsonFetch('/api/auth/status');
      const device = j && (j.device || j);
      return {
        deviceName: String(
          device.device_name || device.deviceName || j.device_name || 'Plum Box'
        ),
        coreVersion: String(
          device.core_version || device.coreVersion || j.core_version || '0.0.0'
        )
      };
    }
  };

  // --- plum.service (앱이 ship한 박스측 백엔드 = manifest.server) ---
  // service.fetch(path, init) 는 앱의 web UI 가 자기 서버 .plu 를
  // /apps/<id>/svc/<path> 로 호출. 박스 세션으로 인증되고, 검증된
  // (userID, appID) 가 X-Plum-* 헤더로 백엔드에 주입됨(클라가 위조 불가).
  // 원본 Response 를 그대로 반환 → .json()/.text()/.blob()/streaming 자유.
  // 'service:call' 권한 필요.
  const service = {
    async fetch(path, init) {
      requirePerm('service:call');
      try {
        return await fetch(service.url(path), Object.assign({ credentials: 'same-origin' }, init || {}));
      } catch (e) {
        throw new NetworkError('service fetch failed: ' + (e && e.message ? e.message : String(e)));
      }
    },
    // url(path) → svc 절대경로. <img src>, EventSource, fetch streaming 등에.
    url(path) {
      const id = appId();
      if (!id) throw new NetworkError('app id unknown (prelude missing)');
      let p = String(path == null ? '/' : path);
      if (p.charAt(0) !== '/') p = '/' + p;
      return '/apps/' + encodeURIComponent(id) + '/svc' + p;
    }
  };

  window.plum = { files: files, user: user, app: app, service: service };
})(window);
