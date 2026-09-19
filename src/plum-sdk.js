/*
 * plum-sdk.js — Plum SDK v0.1 + v0.2 의 production 런타임 (PLUM_SDK_v0.2.md).
 *
 * 박스가 /apps/runtime/plum-sdk.js 한 파일로 서빙. 앱 index.html 이
 *   <script src="/apps/runtime/plum-sdk.js"></script>
 * 한 줄로 import 하면 window.plum 즉시 사용 가능.
 *
 * mock (plum-sdk-mock.js) 과 surface 동일. 차이:
 *   - openPicker      → 박스의 drive/photos 트리에서 고르는 모달 (multiple 지원)
 *   - saveAsPicker    → Drive 폴더 위치 선택 + 파일명 확인 후 new handle grant
 *   - launchFile      → Drive "Open with" 실행 시 ?handle= 쿼리로 넘어온 파일
 *   - url             → 핸들 스트리밍 URL (<video src> 등, Range 지원)
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
  // v0.2: the host has no such capability / the user dismissed a sheet.
  const UnsupportedError = makeErrorClass('UnsupportedError');
  const CancelledError = makeErrorClass('CancelledError');

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
.plum-picker-row.plum-picker-selected { background: #eef2ff; }
.plum-picker-row.plum-picker-selected:hover { background: #e2e8fd; }
.plum-picker-footer-actions {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid #eee;
}
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

  function showOpenPicker(accept, multiple, initialTab) {
    const startOnPhotos = initialTab === 'photo';
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
      const driveTab = el('button', { text: 'Drive', class: 'plum-picker-tab' + (startOnPhotos ? '' : ' active') });
      const photosTab = el('button', { text: 'Photos', class: 'plum-picker-tab' + (startOnPhotos ? ' active' : '') });
      tabs.appendChild(driveTab);
      tabs.appendChild(photosTab);
      card.appendChild(tabs);

      const list = el('div', { class: 'plum-picker-list' });
      card.appendChild(list);

      const pathHint = el('div', { class: 'plum-picker-pathhint', text: '/' });
      card.appendChild(pathHint);

      // openPicker({multiple:true}): rows toggle, footer Open confirms.
      const selected = new Map(); // "kind:path" → descriptor
      let openBtn = null;
      if (multiple) {
        const actions = el('div', { class: 'plum-picker-footer-actions' });
        const cancelBtn = el('button', { text: 'Cancel', class: 'plum-picker-btn' });
        openBtn = el('button', {
          text: 'Open',
          class: 'plum-picker-btn plum-picker-btn-primary'
        });
        openBtn.disabled = true;
        cancelBtn.addEventListener('click', function () { hide(); resolve(null); });
        openBtn.addEventListener('click', function () {
          if (selected.size === 0) return;
          const picked = Array.from(selected.values());
          hide();
          resolve(picked);
        });
        actions.appendChild(cancelBtn);
        actions.appendChild(openBtn);
        card.appendChild(actions);
      }

      function selKey(d) { return d.kind + ':' + d.path; }
      function toggleSelect(row, desc) {
        const key = selKey(desc);
        if (selected.has(key)) {
          selected.delete(key);
          row.classList.remove('plum-picker-selected');
        } else {
          selected.set(key, desc);
          row.classList.add('plum-picker-selected');
        }
        openBtn.disabled = selected.size === 0;
        openBtn.textContent = selected.size > 0 ? 'Open (' + selected.size + ')' : 'Open';
      }
      function attachPick(row, desc) {
        if (multiple) {
          if (selected.has(selKey(desc))) row.classList.add('plum-picker-selected');
          row.addEventListener('click', function () { toggleSelect(row, desc); });
        } else {
          row.addEventListener('click', function () { hide(); resolve(desc); });
        }
      }

      root.appendChild(card);

      let currentTab = startOnPhotos ? 'photo' : 'drive';
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
          attachPick(row, {
            kind: 'drive', path: f.path, name: f.name,
            size: f.size, mtime: new Date(f.modTime).getTime()
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
          attachPick(row, {
            kind: 'photo', path: p.relPath || p.name, name: p.name,
            size: typeof p.size === 'number' ? p.size : 0,
            mtime: typeof p.mtime === 'number' ? p.mtime : 0
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

  function normalizeStartPath(p) {
    if (!p || typeof p !== 'string') return '/';
    const trimmed = p.trim();
    if (!trimmed || trimmed === '/') return '/';
    return trimmed.startsWith('/') ? trimmed.replace(/\/+$/, '') || '/' : '/' + trimmed.replace(/\/+$/, '');
  }

  /**
   * Drive folder browser + filename for save-as.
   * Resolves { parentPath, defaultName } or null on cancel.
   */
  function showSaveAsPicker(opts) {
    const defaultName = opts.defaultName;
    return new Promise(function (resolve, reject) {
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

      const list = el('div', { class: 'plum-picker-list' });
      card.appendChild(list);

      const pathHint = el('div', { class: 'plum-picker-pathhint', text: '/' });
      card.appendChild(pathHint);

      const form = el('div', { class: 'plum-picker-saveform' });
      form.appendChild(el('label', { text: 'File name', class: 'plum-picker-label' }));
      const input = el('input', { class: 'plum-picker-input' });
      input.type = 'text';
      input.value = defaultName;
      form.appendChild(input);
      form.appendChild(el('div', {
        class: 'plum-picker-note',
        text: 'Choose a Drive folder above, then confirm the file name.'
      }));

      const actions = el('div', { class: 'plum-picker-actions' });
      const cancel = el('button', { text: 'Cancel', class: 'plum-picker-btn' });
      const save = el('button', {
        text: 'Save here',
        class: 'plum-picker-btn plum-picker-btn-primary'
      });
      actions.appendChild(cancel);
      actions.appendChild(save);
      form.appendChild(actions);
      card.appendChild(form);
      root.appendChild(card);

      let currentPath = normalizeStartPath(opts.startPath);

      function hide() {
        root.style.display = 'none';
        root.innerHTML = '';
      }

      function confirmSave() {
        const name = (input.value || '').trim() || defaultName;
        if (!name) return;
        const parent = currentPath || '/';
        hide();
        resolve({ defaultName: name, parentPath: parent });
      }

      cancel.addEventListener('click', function () { hide(); resolve(null); });
      save.addEventListener('click', confirmSave);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirmSave();
        }
      });

      function renderFolders(entries) {
        list.innerHTML = '';
        pathHint.textContent = 'Save to: ' + currentPath;

        if (currentPath !== '/' && currentPath !== '') {
          const upRow = el('div', { class: 'plum-picker-row', text: '⬆ ..' });
          upRow.addEventListener('click', function () {
            currentPath = parentPath(currentPath);
            refresh();
          });
          list.appendChild(upRow);
        }

        const dirs = entries.filter(function (e) { return e.isDir; });
        dirs.forEach(function (d) {
          const row = el('div', { class: 'plum-picker-row plum-picker-dir' });
          row.textContent = '📁 ' + d.name;
          row.addEventListener('click', function () {
            currentPath = joinPath(currentPath, d.name);
            refresh();
          });
          list.appendChild(row);
        });
        if (dirs.length === 0) {
          list.appendChild(el('div', {
            text: 'No subfolders — you can save in this folder.',
            class: 'plum-picker-empty'
          }));
        }
      }

      async function refresh() {
        list.innerHTML = '';
        list.appendChild(el('div', { text: 'Loading…', class: 'plum-picker-loading' }));
        try {
          const entries = await fetchDrive(currentPath);
          renderFolders(Array.isArray(entries) ? entries : (entries && entries.items) || []);
        } catch (err) {
          list.innerHTML = '';
          list.appendChild(el('div', {
            text: 'Failed to load: ' + (err && err.message ? err.message : String(err)),
            class: 'plum-picker-error'
          }));
        }
      }

      root.addEventListener('click', function (e) {
        if (e.target === root) {
          hide();
          resolve(null);
        }
      });

      refresh().catch(reject);
      setTimeout(function () {
        try { input.focus(); input.select(); } catch (_) {}
      }, 0);
    });
  }

  // Handle API calls include app id so the box can validate grants even when
  // Referer is stripped (iframe preview / Open with, strict referrer policy).
  function handleFetchHeaders(extra) {
    const headers = Object.assign({}, extra || {});
    const id = appId();
    if (id) headers['X-Plum-App-Id'] = id;
    // The box minted a token for this page (prelude) that proves which app is
    // calling; the header above is only the pre-token fallback.
    const ctx = window.__PLUM_APP__;
    if (ctx && ctx.token) headers['X-Plum-App-Token'] = ctx.token;
    // 공유 링크로 열린 앱은 세션이 없다. 호스트가 실행 URL 에 실어 보낸 공유
    // 토큰을 매 호출에 붙여야 박스가 이 방문자를 알아본다(그리고 매번 공유를
    // 다시 검사한다). 토큰이 없으면 아무것도 붙지 않으므로 평소와 동일하다.
    const token = shareToken();
    if (token) headers['X-Share-Token'] = token;
    return headers;
  }

  // 실행 URL 의 ?shareToken=. 앱이 알 필요 없는 값이라 SDK 안에서만 다룬다.
  function shareToken() {
    try {
      return new URLSearchParams(window.location.search).get('shareToken') || '';
    } catch (e) {
      return '';
    }
  }

  // --- plum.files ---
  async function grantPicked(picked) {
    const r = await fetch('/api/apps/picker/grant', {
      method: 'POST',
      credentials: 'same-origin',
      headers: handleFetchHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ kind: picked.kind, path: picked.path })
    });
    if (!r.ok) {
      let body = null;
      try { body = await r.json(); } catch (_) {}
      throw errorFromResponse(r.status, body);
    }
    const grant = await r.json();
    return { id: grant.id, name: grant.name };
  }

  const files = {
    async openPicker(opts) {
      const multiple = !!(opts && opts.multiple);
      const picked = await showOpenPicker(opts && opts.accept, multiple);
      if (!picked) return null;
      if (!multiple) return grantPicked(picked);
      const out = [];
      for (let i = 0; i < picked.length; i++) {
        out.push(await grantPicked(picked[i]));
      }
      return out;
    },

    // Drive "Open with"로 실행됐을 때 넘겨받은 파일. 쿼리스트링의
    // handle 파라미터를 읽어 검증까지 마친 핸들을 돌려준다. 직접 실행이거나
    // 핸들이 만료된 stale reload 면 null.
    async launchFile() {
      const params = new URLSearchParams(window.location.search);
      const id = params.get('handle');
      if (!id) return null;
      const handle = { id: id, name: params.get('name') || '' };
      try {
        const st = await files.stat(handle);
        return { id: handle.id, name: st.name || handle.name };
      } catch (e) {
        if (e && e.code === 'FileNotFoundError') return null;
        throw e;
      }
    },

    // 핸들의 스트리밍 URL. <video src>/<img src>/부분 fetch(Range 지원)용.
    // readBytes 와 같은 files:read 권한이 필요하다.
    url(handle) {
      requirePerm('files:read');
      if (!handle || !handle.id) {
        throw new FileNotFoundError('url: invalid handle');
      }
      // <img src>/<video src> 처럼 헤더를 붙일 수 없는 곳에 쓰이므로, 공유
      // 링크로 열렸으면 토큰을 쿼리로 실어야 한다(박스는 둘 다 받는다).
      const base = '/api/apps/handle/' + encodeURIComponent(handle.id) + '/read';
      const token = shareToken();
      return token ? base + '?shareToken=' + encodeURIComponent(token) : base;
    },

    /**
     * Save-as: pick a Drive folder, confirm filename, mint a writable handle.
     * opts: { defaultName: string, startPath?: string, accept?: string|string[] }
     * Grant body uses path = selected folder (backend requires it; no Apps auto-place).
     */
    async saveAsPicker(opts) {
      if (!opts || !opts.defaultName) {
        throw new Error('saveAsPicker: defaultName required');
      }
      const result = await showSaveAsPicker({
        defaultName: opts.defaultName,
        startPath: opts.startPath,
        accept: opts.accept
      });
      if (!result) return null;
      const r = await fetch('/api/apps/picker/grant', {
        method: 'POST',
        credentials: 'same-origin',
        headers: handleFetchHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          kind: 'new',
          path: result.parentPath || '/',
          name: result.defaultName
        })
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
          { credentials: 'same-origin', headers: handleFetchHeaders() }
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
            headers: handleFetchHeaders({ 'Content-Type': 'application/octet-stream' }),
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
        { credentials: 'same-origin', headers: handleFetchHeaders() }
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
    // Asks /api/version, which is unauthenticated and actually carries these.
    // This used to read /api/auth/status, which never returned a version — so
    // every app on every box saw "0.0.0" and could not feature-detect at all.
    // /api/status does have it but is owner-only, so a member's app could not
    // read it even knowing where to look.
    async host() {
      let v = {};
      try {
        v = (await jsonFetch('/api/version')) || {};
      } catch (e) {
        // An older box has no /api/version. Fall back to what auth/status now
        // carries, then to a value that reads as "too old to say".
        try {
          v = (await jsonFetch('/api/auth/status')) || {};
        } catch (e2) {
          v = {};
        }
      }
      let name = 'Plum Box';
      try {
        const s = await jsonFetch('/api/auth/status');
        const device = (s && (s.device || s)) || {};
        name = String(device.device_name || device.deviceName || 'Plum Box');
      } catch (e) {
        // Name is cosmetic; a failure here must not break version reporting.
      }
      return {
        deviceName: name,
        coreVersion: String(v.core_version || '0.0.0'),
        osVersion: String(v.os_version || ''),
        apiLevel: Number(v.api_level || 0)
      };
    }
  };

  // --- plum.service (앱이 ship한 박스측 백엔드 = manifest.server) ---
  // --- plum.events ---
  // 박스의 변경 채널(GET /api/events, Server-Sent Events). kinds 는 'drive',
  // 'photos', 'notification', 'apps:<id>' 또는 'apps:*'; 비우면 전부. 콜백은
  // {id, kind, at, payload} 를 받고, 박스가 'reset' 을 보내면 kind='reset' 으로
  // 한 번 불린다(놓친 게 많으니 전부 다시 읽으라는 뜻). 반환값을 부르면 끊는다.
  const events = {
    subscribe(kinds, cb) {
      const list = Array.isArray(kinds) ? kinds : (kinds ? [kinds] : []);
      const url = '/api/events' + (list.length ? '?kinds=' + encodeURIComponent(list.join(',')) : '');
      const es = new EventSource(url, { withCredentials: true });
      const handler = (ev) => {
        let data = null;
        try { data = JSON.parse(ev.data); } catch (_) {}
        cb(data || { kind: ev.type });
      };
      const kindsToListen = list.length ? list : ['drive', 'photos', 'notification'];
      kindsToListen.forEach((k) => {
        if (k.endsWith(':*')) return; // wildcard kinds arrive via onmessage below
        es.addEventListener(k, handler);
      });
      es.onmessage = handler; // events with no matching listener
      es.addEventListener('reset', () => cb({ kind: 'reset' }));
      return () => es.close();
    },
  };

  // --- 개발자 빌드 자동 새로고침 ---
  // 페어링한 키로 설치한 앱(prelude dev:true)은 push 가 끝날 때 박스가
  // apps:<id> 로 {type:'installed'} 를 보낸다. 그 번들은 캐시되지 않으므로
  // 다시 불러오면 새 파일이다 — 개발자는 저장하고 push 만 하면 된다.
  (function autoReloadDevBuild() {
    const ctx = window.__PLUM_APP__;
    if (!ctx || !ctx.dev || !ctx.id || typeof EventSource === 'undefined') return;
    try {
      events.subscribe(['apps:' + String(ctx.id)], (ev) => {
        const p = ev && ev.payload;
        if (p && p.type === 'installed') setTimeout(() => window.location.reload(), 400);
      });
    } catch (_) { /* no session (share link) — nothing to reload for */ }
  })();

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

  // --- plum.theme (호스트 테마 따라가기) ---
  // 박스가 테마를 소유한다(토글이 셸 헤더에 있다). 앱이 그 안에서 혼자 밝은
  // 채로 있으면 안 되므로, 실행 URL 의 ?theme= 로 첫 페인트를 맞추고 이후
  // 변경은 호스트가 postMessage 로 밀어준다. 앱은 아무것도 안 해도
  // documentElement 의 data-theme 이 갱신되니 CSS 만 있으면 따라온다.
  const themeState = (function () {
    const listeners = new Set();
    let current = '';

    function apply(theme) {
      const next = theme === 'dark' ? 'dark' : 'light';
      if (next === current) return;
      current = next;
      try {
        document.documentElement.dataset.theme = next;
      } catch (e) { /* document 없는 환경 */ }
      listeners.forEach(function (fn) {
        try { fn(next); } catch (e) { /* 한 리스너의 예외가 나머지를 막지 않게 */ }
      });
    }

    // 1) 실행 URL 이 실어 보낸 값(있으면 즉시).
    try {
      const q = new URLSearchParams(window.location.search).get('theme');
      if (q === 'dark' || q === 'light') apply(q);
    } catch (e) { /* ignore */ }

    // 2) 호스트가 미는 변경.
    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin) return;
      const d = event.data;
      if (!d || d.source !== 'plum-host' || d.type !== 'theme') return;
      apply(d.theme);
    });

    // 3) 프레임 안이면 현재 값을 한 번 물어본다(URL 에 없었던 경우).
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'plum-app', type: 'theme?' }, window.location.origin);
      }
    } catch (e) { /* cross-origin parent — 그냥 넘어간다 */ }

    return {
      get: function () { return current || 'light'; },
      set: apply,
      subscribe: function (fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.add(fn);
        return function () { listeners.delete(fn); };
      }
    };
  })();

  // 호스트가 쓰는 언어. 앱이 자기 UI 문자열을 그 언어로 그리라고 알려주는
  // 값이다. 테마와 같은 통로 — 실행 URL 의 ?lang= 이 첫 페인트를 맞추고,
  // 사용자가 박스 언어를 바꾸면 호스트가 밀어준다.
  const localeState = (function () {
    const listeners = new Set();
    let current = '';

    function apply(lang) {
      const next = String(lang || '').trim();
      if (!next || next === current) return;
      current = next;
      try {
        document.documentElement.lang = next;
      } catch (e) { /* document 없는 환경 */ }
      listeners.forEach(function (fn) {
        try { fn(next); } catch (e) { /* 한 리스너의 예외가 나머지를 막지 않게 */ }
      });
    }

    try {
      apply(new URLSearchParams(window.location.search).get('lang'));
    } catch (e) { /* ignore */ }

    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin) return;
      const d = event.data;
      if (!d || d.source !== 'plum-host') return;
      if (d.type === 'theme' || d.type === 'locale') apply(d.lang || d.locale);
    });

    return {
      set: apply,
      get: function () {
        if (current) return current;
        // 프레임 밖(단독 실행)에서는 박스가 저장해 둔 값, 그 다음 브라우저.
        try {
          const stored = window.localStorage.getItem('plumLocale');
          if (stored) return stored;
        } catch (e) { /* 저장소 접근 불가 */ }
        return (navigator.language || 'en');
      },
      subscribe: function (fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.add(fn);
        return function () { listeners.delete(fn); };
      }
    };
  })();

  // --- plum.collab (실시간 협업 릴레이) ---
  // 앱은 자기 소켓을 열지 않는다. 방(room)에 join 해서 publish/subscribe 하면
  // 박스가 같은 방의 다른 앱 인스턴스로 그대로 전달한다. 박스는 내용을 해석
  // 하지도, 저장하지도 않는다 — 무엇이 오가는지는 전적으로 앱의 몫이다.
  //
  // 방은 (앱 id, 방 이름)으로 갈린다. 같은 박스의 다른 구성원과 만나야 협업이
  // 되므로 방 이름은 **박스 구성원 사이의 공용 이름 공간**이다. 아무나 보면
  // 안 되는 것을 방에 흘리지 말 것.
  //
  // 소켓은 필요할 때 하나만 열리고, 끊기면 지수 백오프로 다시 붙으면서
  // join 해 둔 방을 전부 자동으로 재참여한다.
  const collab = (function () {
    const rooms = new Map();     // room -> Set<handler>
    const joined = new Set();    // 서버에 join 을 보낸(=보내야 하는) 방
    let socket = null;
    let opening = false;
    let backoff = 1000;
    let retryTimer = null;

    function wsURL() {
      const id = appId();
      if (!id) throw new NetworkError('app id unknown (prelude missing)');
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let u = scheme + '//' + window.location.host +
        '/api/apps/collab/ws?app=' + encodeURIComponent(id);
      // WebSocket 은 헤더를 못 싣는다. 공유 링크로 열렸으면 토큰을 쿼리로.
      const token = shareToken();
      if (token) u += '&shareToken=' + encodeURIComponent(token);
      return u;
    }

    function ensureSocket() {
      if (socket || opening) return;
      opening = true;
      let ws;
      try {
        ws = new WebSocket(wsURL());
      } catch (e) {
        opening = false;
        scheduleRetry();
        return;
      }

      ws.onopen = function () {
        opening = false;
        socket = ws;
        backoff = 1000;
        // 끊긴 사이 join 해 둔 방을 되살린다.
        joined.forEach(function (room) { send({ t: 'join', room: room }); });
      };

      ws.onmessage = function (event) {
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        if (!frame || frame.t !== 'msg') return;
        const handlers = rooms.get(frame.room);
        if (!handlers) return;
        handlers.forEach(function (handler) {
          try {
            handler(frame.data);
          } catch (e) {
            // 한 구독자의 예외가 나머지 전달을 막지 않는다.
          }
        });
      };

      ws.onclose = function () {
        opening = false;
        if (socket === ws) socket = null;
        if (joined.size > 0) scheduleRetry();
      };

      ws.onerror = function () {
        try { ws.close(); } catch (e) { /* onclose 가 재시도를 잡는다 */ }
      };
    }

    function scheduleRetry() {
      if (retryTimer) return;
      const delay = backoff;
      backoff = Math.min(backoff * 2, 30000);
      retryTimer = window.setTimeout(function () {
        retryTimer = null;
        if (joined.size > 0) ensureSocket();
      }, delay);
    }

    function send(frame) {
      if (!socket || socket.readyState !== 1) return false;
      try {
        socket.send(JSON.stringify(frame));
        return true;
      } catch (e) {
        return false;
      }
    }

    return {
      // 호스트가 정해 준 방(파일 단위). 파일을 건네받아 열렸으면 앱은 자기
      // 규칙으로 방 이름을 짓지 말고 이걸 써야 한다 — 그래야 같은 파일을 받은
      // 사람들(주인·공유 링크 방문자)이 한 방에서 만난다. 공유 링크 연결은
      // 박스가 이 방만 허용한다.
      room: function () {
        try {
          return new URLSearchParams(window.location.search).get('collabRoom') || '';
        } catch (e) {
          return '';
        }
      },
      join: function (roomId) {
        const room = String(roomId || '');
        if (!room) return;
        joined.add(room);
        ensureSocket();
        send({ t: 'join', room: room });
      },
      leave: function (roomId) {
        const room = String(roomId || '');
        if (!room) return;
        joined.delete(room);
        rooms.delete(room);
        send({ t: 'leave', room: room });
        if (joined.size === 0 && socket) {
          try { socket.close(); } catch (e) { /* 이미 닫힘 */ }
          socket = null;
        }
      },
      publish: function (roomId, message) {
        const room = String(roomId || '');
        if (!room) return;
        // 아직 소켓이 없으면 열어두고 이번 건은 흘린다. 협업 페이로드는
        // 스냅샷이라 다음 발행이 곧 따라잡는다(큐잉해서 밀린 상태를 뒤늦게
        // 덮어쓰는 편이 더 나쁘다).
        ensureSocket();
        send({ t: 'msg', room: room, data: message });
      },
      subscribe: function (roomId, handler) {
        const room = String(roomId || '');
        if (!room || typeof handler !== 'function') return function () {};
        let handlers = rooms.get(room);
        if (!handlers) {
          handlers = new Set();
          rooms.set(room, handlers);
        }
        handlers.add(handler);
        ensureSocket();
        return function () {
          const set = rooms.get(room);
          if (!set) return;
          set.delete(handler);
          if (set.size === 0) rooms.delete(room);
        };
      }
    };
  })();

  // app.theme() / app.onThemeChange(fn) — 호스트 테마. 권한 불필요.
  app.theme = themeState.get;
  app.onThemeChange = themeState.subscribe;

  // app.locale() / app.onLocaleChange(fn) — 박스가 쓰는 언어. 권한 불필요.
  app.locale = localeState.get;
  app.onLocaleChange = localeState.subscribe;

  // app.setDocumentState({name, state}) — 지금 무슨 문서를 열고 있고 저장됐는지
  // 호스트에 알린다. 셸이 프레임 위 신원 줄과 헤더의 실행 중 앱 칩에 그대로
  // 표시한다(호스트는 앱 내부 상태를 알 방법이 없다). 권한 불필요.
  // 프레임 밖(단독 실행)에서는 조용히 무시된다.
  app.setDocumentState = function (info) {
    try {
      if (!window.parent || window.parent === window) return;
      var payload = info || {};
      window.parent.postMessage({
        source: 'plum-app',
        type: 'docstate',
        name: payload.name == null ? undefined : String(payload.name),
        state: payload.state == null ? undefined : String(payload.state)
      }, window.location.origin);
    } catch (e) {
      // 호스트가 없거나 교차 출처 — 표시가 안 될 뿐 앱 동작에는 영향 없다.
    }
  };

  // --- 네이티브 브리지 (PLUM_NATIVE_BRIDGE_v1.md) ---
  // 폰 앱의 WebView 가 문서 시작 전에 window.__PLUM_NATIVE__ 와
  // window.plumNative.postMessage 를 둔다. 응답은 __plumNativeReply(id, result),
  // 이벤트는 __plumNativeEvent(name, payload) 로 돌아온다. 앱은 이걸 직접
  // 만지지 않고 plum.ui.* 를 쓴다 — 브리지가 없으면 웹 폴백.
  const native = (function () {
    const pending = new Map();
    const listeners = new Map();
    let seq = 0;
    function info() {
      let n = window.__PLUM_NATIVE__;
      if (!n && window.plumNative && typeof window.plumNative.info === 'function') {
        // Android without a document-start script: the interface answers synchronously.
        try { n = JSON.parse(window.plumNative.info()); window.__PLUM_NATIVE__ = n; } catch (e) { n = null; }
      }
      return n && typeof n === 'object' ? n : null;
    }
    function available() {
      return !!(info() && window.plumNative && typeof window.plumNative.postMessage === 'function');
    }
    function has(cap) {
      const n = info();
      return !!(n && Array.isArray(n.capabilities) && n.capabilities.indexOf(cap) !== -1 && available());
    }
    function fail(err, method) {
      const code = err && err.code ? String(err.code) : 'failed';
      const msg = err && err.message ? String(err.message) : 'native ' + method + ' failed';
      let e;
      if (code === 'cancelled') e = new CancelledError(msg);
      else if (code === 'unsupported' || code === 'unavailable') e = new UnsupportedError(msg);
      else if (code === 'denied') e = new PermissionDeniedError(msg);
      else e = new NetworkError(msg);
      e.nativeCode = code;
      return e;
    }
    function call(method, params, timeoutMs) {
      if (!available()) return Promise.reject(new UnsupportedError('no native bridge for ' + method));
      const id = 'r-' + (++seq) + '-' + Date.now().toString(36);
      return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          pending.delete(id);
          const e = new NetworkError('native ' + method + ': no reply');
          e.nativeCode = 'timeout';
          reject(e);
        }, timeoutMs || 30000);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer, method: method });
        try {
          window.plumNative.postMessage(JSON.stringify({ id: id, method: method, params: params || {} }));
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new NetworkError('native ' + method + ': ' + (e && e.message ? e.message : String(e))));
        }
      });
    }
    window.__plumNativeReply = function (id, result) {
      const p = pending.get(String(id));
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(String(id));
      if (typeof result === 'string') {
        try { result = JSON.parse(result); } catch (e) { result = { ok: false, error: { code: 'failed', message: 'unreadable reply' } }; }
      }
      if (result && result.ok) p.resolve(result.result || {});
      else p.reject(fail(result && result.error, p.method));
    };
    window.__plumNativeEvent = function (name, payload) {
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { /* keep as is */ } }
      const set = listeners.get(String(name));
      if (!set) return;
      set.forEach(function (fn) { try { fn(payload || {}); } catch (e) { /* one listener must not break the rest */ } });
    };
    function on(name, fn) {
      let set = listeners.get(name);
      if (!set) { set = new Set(); listeners.set(name, set); }
      set.add(fn);
      return function () { set.delete(fn); };
    }
    // Host-owned state pushed by the shell.
    on('theme', function (p) { themeState.set(p && p.theme); });
    on('locale', function (p) { localeState.set(p && (p.locale || p.lang)); });
    return { info: info, available: available, has: has, call: call, on: on };
  })();

  // 웹 폴백용 카메라 입력: <input type=file capture>. 취소는 'cancel' 이벤트
  // (최신 브라우저) 또는 포커스 복귀 뒤 1초 무응답으로 판단한다.
  function pickCaptureFile(mode) {
    return new Promise(function (resolve) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = mode === 'video' ? 'video/*' : 'image/*';
      input.setAttribute('capture', 'environment');
      input.style.display = 'none';
      let done = false;
      function finish(f) { if (done) return; done = true; try { input.remove(); } catch (e) { /* ignore */ } resolve(f || null); }
      input.addEventListener('change', function () { finish(input.files && input.files[0]); });
      input.addEventListener('cancel', function () { finish(null); });
      window.addEventListener('focus', function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(function () { if (!done && !(input.files && input.files.length)) finish(null); }, 1000);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  // --- plum.ui (v0.2) ---
  let backOff = null;
  const ui = {
    async share(opts) {
      const o = opts || {};
      const handles = Array.isArray(o.handles) ? o.handles.filter(function (h) { return h && h.id; }) : [];
      if (handles.length) requirePerm('files:read');
      if (!o.text && !o.url && !handles.length) throw new Error('share: text, url or handles required');
      if (native.has('share')) {
        // The shell fetches the handles' bytes itself; it needs to read them
        // AS this app, so the page's app token (prelude) rides along. The
        // shell already holds the session — the token adds the app identity.
        const ctx = window.__PLUM_APP__ || {};
        await native.call('share', {
          text: o.text == null ? undefined : String(o.text),
          url: o.url == null ? undefined : String(o.url),
          handles: handles.map(function (h) { return { id: String(h.id), name: String(h.name || '') }; }),
          token: handles.length && ctx.token ? String(ctx.token) : undefined
        });
        return;
      }
      if (navigator.share) {
        const data = {};
        if (o.text) data.text = String(o.text);
        if (o.url) data.url = String(o.url);
        if (handles.length && typeof File !== 'undefined') {
          const list = [];
          for (let i = 0; i < handles.length; i++) {
            const bytes = await files.readBytes(handles[i]);
            list.push(new File([bytes], handles[i].name || 'file'));
          }
          if (navigator.canShare && navigator.canShare({ files: list })) data.files = list;
          else if (!o.text && !o.url) throw new UnsupportedError('this browser cannot share files');
        }
        try {
          await navigator.share(data);
        } catch (e) {
          if (e && e.name === 'AbortError') throw new CancelledError('share cancelled');
          throw new NetworkError('share failed: ' + (e && e.message ? e.message : String(e)));
        }
        return;
      }
      throw new UnsupportedError('sharing is not available on this host');
    },
    clipboard: {
      async write(text) {
        if (native.has('clipboard')) { await native.call('clipboard.write', { text: String(text == null ? '' : text) }); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(String(text == null ? '' : text)); return; }
        throw new UnsupportedError('clipboard is not available on this host');
      },
      async read() {
        if (native.has('clipboard')) { const r = await native.call('clipboard.read', {}); return String(r && r.text != null ? r.text : ''); }
        if (navigator.clipboard && navigator.clipboard.readText) {
          try { return await navigator.clipboard.readText(); } catch (e) { throw new PermissionDeniedError('clipboard read denied'); }
        }
        throw new UnsupportedError('clipboard is not available on this host');
      }
    },
    async capture(opts) {
      requirePerm('files:write');
      const mode = opts && opts.mode === 'video' ? 'video' : 'photo';
      if (native.has('capture')) {
        // The shell shoots and uploads into the user's Drive, then tells us
        // where the file landed; the handle is minted HERE, with this page's
        // app token, so the grant stays tied to this app and its permissions.
        const r = await native.call('capture', { mode: mode }, 10 * 60 * 1000);
        if (!r || !r.path) throw new NetworkError('capture: the shell returned no file');
        return grantPicked({ kind: r.kind || 'drive', path: String(r.path) });
      }
      const file = await pickCaptureFile(mode);
      if (!file) throw new CancelledError('capture cancelled');
      const handle = await files.saveAsPicker({ defaultName: file.name || (mode === 'video' ? 'capture.mp4' : 'capture.jpg'), startPath: '/Camera' });
      if (!handle) throw new CancelledError('save cancelled');
      await files.writeBytes(handle, new Uint8Array(await file.arrayBuffer()));
      return handle;
    },
    async haptic(style) {
      const st = String(style || 'light');
      if (native.has('haptic')) { await native.call('haptic', { style: st }); return; }
      if (navigator.vibrate) { try { navigator.vibrate(st === 'heavy' ? 30 : st === 'medium' ? 20 : 10); } catch (e) { /* ignore */ } }
    },
    async openExternal(url) {
      const u = String(url || '');
      if (!/^https?:\/\//i.test(u)) throw new Error('openExternal: an http(s) URL is required');
      if (native.has('openExternal')) { await native.call('openExternal', { url: u }); return; }
      window.open(u, '_blank', 'noopener');
    },
    biometric: {
      async confirm(reason) {
        if (native.has('biometric')) { await native.call('biometric.confirm', { reason: String(reason || '') }, 2 * 60 * 1000); return; }
        throw new UnsupportedError('biometric confirmation is not available on this host');
      }
    },
    nav: {
      setBackHandler(fn) {
        if (!native.has('nav')) return false;
        if (backOff) { backOff(); backOff = null; }
        if (typeof fn === 'function') {
          backOff = native.on('back', function () { fn(); });
          native.call('nav.setBackHandler', { enabled: true }).catch(function () { /* older shell */ });
        } else {
          native.call('nav.setBackHandler', { enabled: false }).catch(function () { /* older shell */ });
        }
        return true;
      },
      close() {
        if (native.has('nav')) { native.call('nav.close', {}).catch(function () { /* ignore */ }); return; }
        try {
          if (window.parent && window.parent !== window) window.parent.postMessage({ source: 'plum-app', type: 'close' }, window.location.origin);
        } catch (e) { /* no host */ }
      }
    }
  };

  // --- plum.entitlement (v0.2): the store receipts this box holds for the app ---
  const entitlement = {
    async get() {
      const id = appId();
      if (!id) throw new NetworkError('app id unknown (prelude missing)');
      return jsonFetch('/api/apps/' + encodeURIComponent(id) + '/entitlement');
    },
    async refresh() {
      const j = await jsonFetch('/api/apps/entitlements/refresh', { method: 'POST' });
      return Number((j && j.receipts) || 0);
    }
  };

  // --- plum.photos (v0.2): the picker opened on its Photos tab ---
  const photos = {
    async pick(opts) {
      requirePerm('files:read');
      const multiple = !!(opts && opts.multiple);
      const picked = await showOpenPicker('image/*', multiple, 'photo');
      if (!picked) return null;
      if (!multiple) return grantPicked(picked);
      const out = [];
      for (let i = 0; i < picked.length; i++) out.push(await grantPicked(picked[i]));
      return out;
    }
  };

  // app.capabilities() — what this host can do, and through what. Additions
  // never bump api_level (compat.yaml), so apps feature-detect with this.
  app.capabilities = async function () {
    let apiLevel = 1;
    try { const v = await jsonFetch('/api/version'); apiLevel = Number((v && v.api_level) || 1); } catch (e) { /* older box */ }
    const n = native.available() ? native.info() : null;
    const src = function (cap, webOk) { return native.has(cap) ? 'native' : (webOk ? 'web' : 'none'); };
    return {
      sdk: '0.2',
      apiLevel: apiLevel,
      native: n ? {
        platform: String(n.platform || ''),
        version: Number(n.version || 0),
        capabilities: Array.isArray(n.capabilities) ? n.capabilities.slice() : []
      } : null,
      ui: {
        share: src('share', !!navigator.share),
        clipboard: src('clipboard', !!(navigator.clipboard && navigator.clipboard.writeText)),
        capture: src('capture', typeof document !== 'undefined'),
        haptic: src('haptic', !!navigator.vibrate),
        biometric: src('biometric', false),
        nav: src('nav', false)
      }
    };
  };

  // app.open(appId, path?) — hand the user to another app. The shell decides
  // how (phone: swap the WebView; web: launchpad route); not installed → store.
  app.open = async function (targetAppId, path) {
    const id = String(targetAppId || '');
    if (!id) throw new Error('app.open: appId required');
    const p = path ? String(path) : '';
    if (native.has('nav')) { await native.call('nav.openApp', { app_id: id, path: p }); return; }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'plum-app', type: 'open-app', appId: id, path: p }, window.location.origin);
        return;
      }
    } catch (e) { /* no host */ }
    window.location.href = '/apps/' + encodeURIComponent(id) + '/' + (p ? p.replace(/^\//, '') : '');
  };

  window.plum = {
    files: files, user: user, app: app, service: service, collab: collab, events: events,
    ui: ui, entitlement: entitlement, photos: photos
  };
})(window);
