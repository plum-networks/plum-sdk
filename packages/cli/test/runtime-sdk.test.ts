// The production runtime (src/plum-sdk.js, mirrored from plum-box-core
// web/static/apps/runtime/) loaded into a hand-rolled window: enough DOM to
// prove the v0.2 surface exists, the native bridge round-trips, and the
// fallbacks behave — without a browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const RUNTIME = join(__dirname, '..', '..', '..', 'src', 'plum-sdk.js');

type AnyRec = Record<string, any>;

/**
 * The nth message the page posted to the native bridge, parsed.
 *
 * `sent[i]` is `string | undefined` under noUncheckedIndexedAccess, and a
 * message that was never sent should fail saying so rather than surface as a
 * JSON parse error three lines later.
 */
function sentAt(sent: string[], i: number): AnyRec {
  const raw = sent[i];
  if (typeof raw !== 'string') throw new Error(`no native message #${i} was sent (got ${sent.length})`);
  return JSON.parse(raw) as AnyRec;
}

function makeWindow(opts: { native?: AnyRec; sent?: string[]; fetch?: (url: string, init?: AnyRec) => Promise<AnyRec> } = {}): AnyRec {
  const listeners: Record<string, Array<(e: AnyRec) => void>> = {};
  const win: AnyRec = {
    location: { search: '?theme=dark&lang=ko', origin: 'https://box.test', href: 'https://box.test/apps/dev.a.x/' },
    addEventListener(name: string, fn: (e: AnyRec) => void) { (listeners[name] ??= []).push(fn); },
    removeEventListener() {},
    setTimeout, clearTimeout,
    navigator: { language: 'en', vibrate: undefined, share: undefined, clipboard: undefined },
    document: { documentElement: { dataset: {}, lang: '' }, createElement: () => ({ style: {}, addEventListener() {}, remove() {}, click() {} }), body: { appendChild() {} }, head: { appendChild() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    URLSearchParams, JSON, Map, Set, Promise, Error, Object, Array, String, Number, Date, RegExp, Uint8Array, encodeURIComponent, decodeURIComponent,
    fetch: opts.fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    __PLUM_APP__: { id: 'dev.a.x', perms: ['files:read', 'files:write', 'user:profile', 'service:call'], version: '1.0.0', token: 't' },
  };
  win.window = win;
  win.self = win;
  win.parent = win;
  if (opts.native) {
    win.__PLUM_NATIVE__ = opts.native;
    win.plumNative = { postMessage: (s: string) => opts.sent?.push(s) };
  }
  return win;
}

function load(win: AnyRec) {
  runInNewContext(readFileSync(RUNTIME, 'utf8'), win, { filename: 'plum-sdk.js' });
  return win.plum as AnyRec;
}

describe('runtime SDK v0.2', () => {
  it('exposes the v0.2 namespaces and stays v0.1-compatible', () => {
    const plum = load(makeWindow());
    for (const ns of ['files', 'user', 'app', 'service', 'events', 'collab', 'ui', 'entitlement', 'photos']) expect(plum[ns], ns).toBeTruthy();
    expect(typeof plum.app.capabilities).toBe('function');
    expect(typeof plum.app.open).toBe('function');
    expect(plum.app.theme()).toBe('dark');
    expect(plum.app.locale()).toBe('ko');
  });

  it('reports web fallbacks when there is no bridge', async () => {
    const win = makeWindow();
    win.navigator.share = async () => {};
    const plum = load(win);
    const caps = await plum.app.capabilities();
    expect(caps.sdk).toBe('0.2');
    expect(caps.native).toBeNull();
    expect(caps.ui).toEqual({ share: 'web', clipboard: 'none', capture: 'web', haptic: 'none', biometric: 'none', nav: 'none' });
    expect(plum.ui.nav.setBackHandler(() => {})).toBe(false);
    await expect(plum.ui.biometric.confirm('why')).rejects.toMatchObject({ code: 'UnsupportedError' });
    await expect(plum.ui.clipboard.write('x')).rejects.toMatchObject({ code: 'UnsupportedError' });
  });

  it('round-trips a native call and maps error codes', async () => {
    const sent: string[] = [];
    const win = makeWindow({ native: { version: 1, platform: 'ios', capabilities: ['share', 'clipboard', 'nav', 'biometric'] }, sent });
    const plum = load(win);
    const caps = await plum.app.capabilities();
    expect(caps.native.platform).toBe('ios');
    expect(caps.ui.share).toBe('native');
    expect(caps.ui.capture).toBe('web');

    const p = plum.ui.share({ text: 'hi' });
    expect(sent).toHaveLength(1);
    const req = sentAt(sent, 0);
    expect(req.method).toBe('share');
    expect(req.params).toEqual({ text: 'hi', handles: [] });
    win.__plumNativeReply(req.id, { ok: true, result: {} });
    await expect(p).resolves.toBeUndefined();

    const p2 = plum.ui.clipboard.read();
    win.__plumNativeReply(sentAt(sent, 1).id, JSON.stringify({ ok: false, error: { code: 'cancelled', message: 'nope' } }));
    await expect(p2).rejects.toMatchObject({ code: 'CancelledError', nativeCode: 'cancelled' });

    const p3 = plum.ui.biometric.confirm('unlock');
    win.__plumNativeReply(sentAt(sent, 2).id, { ok: false, error: { code: 'unavailable', message: 'no Face ID' } });
    await expect(p3).rejects.toMatchObject({ code: 'UnsupportedError' });

    // Unknown reply ids are ignored, not thrown.
    expect(() => win.__plumNativeReply('nope', { ok: true })).not.toThrow();
  });

  it('delivers back and theme events from the shell', async () => {
    const sent: string[] = [];
    const win = makeWindow({ native: { version: 1, platform: 'android', capabilities: ['nav'] }, sent });
    const plum = load(win);
    let backs = 0;
    expect(plum.ui.nav.setBackHandler(() => { backs++; })).toBe(true);
    expect(sentAt(sent, 0)).toMatchObject({ method: 'nav.setBackHandler', params: { enabled: true } });
    win.__plumNativeEvent('back', '{}');
    expect(backs).toBe(1);
    const seen: string[] = [];
    plum.app.onThemeChange((t: string) => seen.push(t));
    win.__plumNativeEvent('theme', { theme: 'light' });
    expect(plum.app.theme()).toBe('light');
    expect(seen).toEqual(['light']);
    plum.ui.nav.setBackHandler(null);
    win.__plumNativeEvent('back', {});
    expect(backs).toBe(1);
  });

  it('entitlement.get hits the app endpoint', async () => {
    const urls: string[] = [];
    const win = makeWindow({ fetch: async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ skus: [{ sku: 'pro', kind: 'one_time', expires_at: '', active: true }], refreshed_at: 'x', stale: false }) }; } });
    const plum = load(win);
    const e = await plum.entitlement.get();
    expect(e.skus[0].sku).toBe('pro');
    expect(urls[0]).toBe('/api/apps/dev.a.x/entitlement');
  });
});
