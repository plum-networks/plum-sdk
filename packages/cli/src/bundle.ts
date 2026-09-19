// Packaging and signing, byte-compatible with the box's trust package:
// META/MANIFEST.sha256 lists "<sha256hex>  <path>" for every non-META file,
// sorted by path bytes; META/publisher.pub, META/publisher.sig (signature over
// "plum-publisher-v1\n" + MANIFEST), optional META/recovery.pub and
// META/rotation.json.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { b64url, formatPublicKey, kid, parsePublicKey, PURPOSE_PUBLISHER, signPayload, verifyPayload, type PublisherKey, type Rotation } from './keys.js';
import { checkElf, MAX_BUNDLE_FILES, MAX_ENTRY_BYTES, MAX_PLU_BYTES, validateManifest, type Manifest, type Problem } from './manifest.js';
import { readZip, writeZip, type ZipEntry } from './zip.js';

export const META_DIR = 'META/';
export const META_MANIFEST = 'META/MANIFEST.sha256';
export const META_PUBLISHER = 'META/publisher.pub';
export const META_SIGNATURE = 'META/publisher.sig';
export const META_RECOVERY = 'META/recovery.pub';
export const META_ROTATION = 'META/rotation.json';

const SKIP_DIRS = new Set(['node_modules', '.git', 'META']);

/** Collects files under dir (skipping VCS, node_modules, dotfiles, META/). */
export function collectFiles(dir: string, ignore: string[] = []): ZipEntry[] {
  const out: ZipEntry[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = join(d, name);
      const rel = relative(dir, full).split('\\').join('/');
      if (ignore.some((g) => rel === g || rel.startsWith(g.replace(/\/$/, '') + '/'))) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push({ name: rel, data: readFileSync(full) });
    }
  };
  walk(dir);
  return out;
}

function byPathBytes(a: ZipEntry, b: ZipEntry): number {
  return Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8'));
}

export interface SignOptions {
  key: PublisherKey;
  recoveryPub?: Buffer;
  rotation?: Rotation;
}

/** Validates the bundle contents the way the box will. */
export function checkBundle(entries: ZipEntry[], allowHostArch = false): { manifest: Manifest | null; problems: Problem[] } {
  const problems: Problem[] = [];
  const files = entries.filter((e) => !e.name.startsWith(META_DIR));
  if (files.length > MAX_BUNDLE_FILES) problems.push({ level: 'error', message: `${files.length} files; max ${MAX_BUNDLE_FILES}` });
  const names = new Set(files.map((e) => e.name));
  for (const e of files) {
    if (e.data.length > MAX_ENTRY_BYTES) problems.push({ level: 'error', message: `${e.name} is ${e.data.length} bytes; max ${MAX_ENTRY_BYTES} per file` });
    if (e.name.split('/').some((s) => s === '..' || s === '')) problems.push({ level: 'error', message: `unsafe path ${e.name}` });
  }
  const manifestEntry = files.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) {
    problems.push({ level: 'error', message: 'manifest.json missing at the bundle root' });
    return { manifest: null, problems };
  }
  const { manifest, problems: mp } = validateManifest(manifestEntry.data, (rel) => names.has(rel));
  problems.push(...mp);
  if (manifest) problems.push(...checkSdkUsage(manifest, files));
  if (manifest?.server?.bin && names.has(manifest.server.bin)) {
    const bin = files.find((e) => e.name === manifest.server!.bin)!;
    const p = checkElf(bin.data, allowHostArch);
    if (p) problems.push(p);
  }
  return { manifest, problems };
}

/** Produces a signed .plu from entries (any existing META/* is dropped). */
export function signBundle(entries: ZipEntry[], opts: SignOptions): Buffer {
  const files = entries.filter((e) => !e.name.startsWith(META_DIR)).sort(byPathBytes);
  const hashes = files.map((e) => `${createHash('sha256').update(e.data).digest('hex')}  ${e.name}\n`);
  const manifest = Buffer.from(hashes.join(''), 'utf8');
  const sig = signPayload(opts.key, PURPOSE_PUBLISHER, manifest);
  const meta: ZipEntry[] = [
    { name: META_MANIFEST, data: manifest },
    { name: META_PUBLISHER, data: Buffer.from(formatPublicKey(opts.key.pub) + '\n') },
    { name: META_SIGNATURE, data: Buffer.from(b64url.encode(sig) + '\n') },
  ];
  if (opts.recoveryPub) meta.push({ name: META_RECOVERY, data: Buffer.from(formatPublicKey(opts.recoveryPub) + '\n') });
  if (opts.rotation) meta.push({ name: META_ROTATION, data: Buffer.from(JSON.stringify(opts.rotation, null, 2) + '\n') });
  const out = writeZip([...files, ...meta]);
  if (out.length > MAX_PLU_BYTES) throw new Error(`.plu is ${out.length} bytes; max ${MAX_PLU_BYTES}`);
  return out;
}

/** Re-signs an existing .plu (its META/ block is replaced). */
export function resignPlu(plu: Buffer, opts: SignOptions): Buffer {
  return signBundle(readZip(plu), opts);
}

/** Inspects a .plu: signer, covered files, whether the signature verifies. */
export function inspectPlu(plu: Buffer): { publisher?: string; recovery?: string; files: string[]; signed: boolean } {
  const entries = readZip(plu);
  const meta = new Map(entries.filter((e) => e.name.startsWith(META_DIR)).map((e) => [e.name, e.data]));
  const files = entries.filter((e) => !e.name.startsWith(META_DIR)).map((e) => e.name).sort();
  const pub = meta.get(META_PUBLISHER)?.toString('utf8').trim();
  const rec = meta.get(META_RECOVERY)?.toString('utf8').trim();
  return { publisher: pub, recovery: rec, files, signed: meta.has(META_SIGNATURE) && meta.has(META_MANIFEST) && !!pub };
}

/** Verifies a .plu the way the box does (signature + exact file coverage). */
export function verifyPlu(plu: Buffer): { ok: true; publisher: string; kid: string; files: number } | { ok: false; reason: string } {
  const entries = readZip(plu);
  const meta = new Map(entries.filter((e) => e.name.startsWith(META_DIR)).map((e) => [e.name, e.data]));
  const files = new Map(entries.filter((e) => !e.name.startsWith(META_DIR)).map((e) => [e.name, e.data]));
  const sig = meta.get(META_SIGNATURE);
  const pubText = meta.get(META_PUBLISHER);
  const man = meta.get(META_MANIFEST);
  if (!sig && !pubText && !man) return { ok: false, reason: 'unsigned (no META/ block)' };
  if (!sig || !pubText || !man) return { ok: false, reason: 'META/ is incomplete' };
  let pub: Buffer;
  try {
    pub = parsePublicKey(pubText.toString('utf8'));
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (!verifyPayload(pub, PURPOSE_PUBLISHER, man, b64url.decode(sig.toString('utf8').trim()))) {
    return { ok: false, reason: 'publisher signature does not verify' };
  }
  const listed = new Map<string, string>();
  for (const line of man.toString('utf8').split('\n')) {
    if (!line) continue;
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!m) return { ok: false, reason: `bad MANIFEST line: ${line}` };
    listed.set(m[2]!, m[1]!);
  }
  for (const p of listed.keys()) if (!files.has(p)) return { ok: false, reason: `listed file "${p}" missing from bundle` };
  for (const p of files.keys()) if (!listed.has(p)) return { ok: false, reason: `file "${p}" is not covered by the signature` };
  for (const [p, want] of listed) {
    if (createHash('sha256').update(files.get(p)!).digest('hex') !== want) return { ok: false, reason: `"${p}" does not match its listed hash` };
  }
  return { ok: true, publisher: formatPublicKey(pub), kid: kid(pub), files: files.size };
}


/**
 * The SDK refuses calls whose permission the manifest does not declare, and the
 * owner can only allow declared permissions — so an undeclared call is a
 * runtime error every time. Warn when the app's own scripts use an SDK
 * namespace the manifest does not cover.
 */
export function checkSdkUsage(manifest: Manifest, files: ZipEntry[]): Problem[] {
  const declared = new Set(manifest.permissions ?? []);
  const needs: Array<[RegExp, string, string]> = [
    [/\bplum\.user\./, 'user:profile', 'plum.user.*'],
    [/\bplum\.service\./, 'service:call', 'plum.service.*'],
    [/\bplum\.files\.(openPicker|readBytes|list|stat)\b/, 'files:read', 'plum.files.openPicker/readBytes'],
    [/\bplum\.files\.(saveAsPicker|writeBytes|create)\b/, 'files:write', 'plum.files.saveAsPicker/writeBytes'],
  ];
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!/\.(html?|m?js)$/i.test(f.name) || f.data.length > 4 * 1024 * 1024) continue;
    const text = f.data.toString('utf8');
    for (const [re, perm, what] of needs) {
      if (seen.has(perm) || declared.has(perm) || !re.test(text)) continue;
      seen.add(perm);
      out.push({ level: 'warning', message: `${f.name} calls ${what} but manifest.permissions lacks "${perm}" — the call will fail with PermissionDeniedError` });
    }
  }
  return out;
}
