// The handful of box and Plum Store endpoints the CLI talks to.
import type { Credentials } from './config.js';

/** Who answered: the developer's box (or the emulator) or Plum Store. */
export type Origin = 'box' | 'store';

export class BoxError extends Error {
  constructor(public status: number, public code: string, message: string, public origin: Origin = 'box') {
    super(message);
  }
}

interface ErrorBody {
  error?: unknown;
  message?: unknown;
  detail?: unknown;
}

/**
 * Turns an error response into a code and a sentence. The box answers
 * {"error": code, "message": text}; Plum Store (FastAPI) wraps the same pair as
 * {"detail": {"error": code, "detail": text}}, and FastAPI's own errors are
 * {"detail": "text"} or {"detail": [{msg, loc}, …]}. Every shape has to come
 * through, or the developer sees "400 Bad Request" and nothing else.
 */
export function errorFromBody(status: number, statusText: string, body: unknown, origin: Origin = 'box'): BoxError {
  let code = `http_${status}`;
  let message = statusText;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  if (body && typeof body === 'object') {
    const j = body as ErrorBody;
    if (text(j.error)) code = text(j.error)!;
    if (text(j.message)) message = text(j.message)!;
    else if (text(j.error)) message = text(j.error)!;
    const d = j.detail;
    if (text(d)) message = text(d)!;
    else if (Array.isArray(d) && d.length) {
      const first = d[0] as { msg?: unknown; loc?: unknown };
      const where = Array.isArray(first?.loc) ? first.loc.filter((x) => x !== 'body').join('.') : '';
      if (text(first?.msg)) message = where ? `${where}: ${text(first.msg)}` : text(first.msg)!;
      code = code === `http_${status}` ? 'invalid_request' : code;
    } else if (d && typeof d === 'object') {
      const n = d as ErrorBody;
      if (text(n.error)) code = text(n.error)!;
      if (text(n.detail)) message = text(n.detail)!;
      else if (text(n.message)) message = text(n.message)!;
      else if (text(n.error)) message = text(n.error)!;
    }
  }
  return new BoxError(status, code, message, origin);
}

async function readError(r: Response, origin: Origin = 'box'): Promise<BoxError> {
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    /* not json */
  }
  return errorFromBody(r.status, r.statusText, body, origin);
}

export async function pairBegin(box: string, pubkey: string, name: string, namespace: string) {
  const r = await fetch(new URL('/api/apps/publishers/pair', box), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, name, namespace_prefix: namespace }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { pairing_id: string; kid: string; expires_in: number; hint: string };
}

export async function pairConfirm(box: string, pairingId: string, code: string) {
  const r = await fetch(new URL('/api/apps/publishers/pair/confirm', box), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_id: pairingId, code }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean; kid: string; namespace_prefix: string; trust_level: number; token?: string };
}

function auth(c: Credentials): Record<string, string> {
  return { Authorization: `Bearer ${c.token}` };
}

export interface InstallResult {
  ok: boolean;
  app_id: string;
  version: string;
  name: string;
  url: string;
  publisher_kid: string;
  countersign_kind: string;
}

export async function install(c: Credentials, plu: Buffer, expectedAppId?: string): Promise<InstallResult> {
  const u = new URL('/api/apps/install', c.box);
  if (expectedAppId) u.searchParams.set('app_id', expectedAppId);
  const r = await fetch(u, { method: 'POST', headers: { ...auth(c), 'Content-Type': 'application/zip' }, body: new Uint8Array(plu) });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as InstallResult;
}

export async function status(c: Credentials, appId: string) {
  const r = await fetch(new URL(`/api/apps/${encodeURIComponent(appId)}/status`, c.box), { headers: auth(c) });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as Record<string, unknown>;
}

export async function restart(c: Credentials, appId: string) {
  const r = await fetch(new URL(`/api/apps/${encodeURIComponent(appId)}/restart`, c.box), { method: 'POST', headers: auth(c) });
  if (!r.ok) throw await readError(r);
}

export async function uninstall(c: Credentials, appId: string) {
  const r = await fetch(new URL(`/api/apps/${encodeURIComponent(appId)}/uninstall`, c.box), { method: 'POST', headers: auth(c) });
  if (!r.ok) throw await readError(r);
}

export async function logs(c: Credentials, appId: string): Promise<string[]> {
  const r = await fetch(new URL(`/api/apps/${encodeURIComponent(appId)}/logs`, c.box), { headers: auth(c) });
  if (!r.ok) throw await readError(r);
  return ((await r.json()) as { lines: string[] }).lines;
}

/** Follows the app's log stream (SSE), calling onLine until aborted. */
export async function followLogs(c: Credentials, appId: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const r = await fetch(new URL(`/api/apps/${encodeURIComponent(appId)}/logs?follow=1`, c.box), { headers: auth(c), signal });
  if (!r.ok) throw await readError(r);
  if (!r.body) return;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) onLine(line.slice(6));
        else if (line === 'event: end') return;
      }
    }
  }
}

export interface PublishResult {
  app_id: string;
  version: string;
  status: string;
  created_app: boolean;
  publisher_kid?: string;
  countersign_kind?: string;
  rotated?: boolean;
}

/**
 * Uploads a signed .plu to Plum Store with a publisher token (public → review
 * queue, beta → your testers). `icon` is the app's PNG when it is not already in
 * the bundle as manifest.icon; the store needs one for an app's first upload.
 */
export async function publish(
  store: string,
  token: string,
  plu: Buffer,
  filename: string,
  channel: 'public' | 'beta' = 'public',
  icon?: Buffer,
): Promise<PublishResult> {
  const form = new FormData();
  form.append('plu', new Blob([new Uint8Array(plu)], { type: 'application/octet-stream' }), filename);
  form.append('channel', channel);
  if (icon) form.append('icon', new Blob([new Uint8Array(icon)], { type: 'image/png' }), 'icon.png');
  const r = await fetch(new URL('/v1/publisher/versions', store), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!r.ok) throw await readError(r, 'store');
  return (await r.json()) as PublishResult;
}

/** The app-id namespaces this publisher owns in Plum Store, e.g. ["dev.jan"]. */
export async function storeNamespaces(store: string, token: string): Promise<string[]> {
  const r = await fetch(new URL('/v1/publisher/namespaces', store), { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw await readError(r, 'store');
  const j = (await r.json()) as { namespaces?: { prefix?: string }[] };
  return (j.namespaces ?? []).map((n) => String(n.prefix ?? '')).filter(Boolean);
}

export interface Tester {
  box_serial: string;
  note?: string | null;
  created_at?: string | null;
}

export async function testers(store: string, token: string, appId: string): Promise<Tester[]> {
  const r = await fetch(new URL(`/v1/publisher/apps/${encodeURIComponent(appId)}/testers`, store), { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw await readError(r, 'store');
  return (await r.json()) as Tester[];
}

export async function addTester(store: string, token: string, appId: string, serial: string, note?: string): Promise<Tester> {
  const r = await fetch(new URL(`/v1/publisher/apps/${encodeURIComponent(appId)}/testers`, store), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ box_serial: serial, note: note ?? null }),
  });
  if (!r.ok) throw await readError(r, 'store');
  return (await r.json()) as Tester;
}

export async function removeTester(store: string, token: string, appId: string, serial: string): Promise<void> {
  const r = await fetch(new URL(`/v1/publisher/apps/${encodeURIComponent(appId)}/testers/${encodeURIComponent(serial)}`, store), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw await readError(r, 'store');
}

export async function trust(c: Credentials) {
  const r = await fetch(new URL('/api/apps/trust', c.box), { headers: auth(c) });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { level: number };
}
