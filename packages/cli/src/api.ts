// The handful of box endpoints the CLI talks to.
import type { Credentials } from './config.js';

export class BoxError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function readError(r: Response): Promise<BoxError> {
  let code = `http_${r.status}`;
  let message = r.statusText;
  try {
    const j = (await r.json()) as { error?: string; message?: string };
    if (j.error) code = j.error;
    if (j.message) message = j.message;
    else if (j.error) message = j.error;
  } catch {
    /* not json */
  }
  return new BoxError(r.status, code, message);
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

export async function trust(c: Credentials) {
  const r = await fetch(new URL('/api/apps/trust', c.box), { headers: auth(c) });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { level: number };
}
