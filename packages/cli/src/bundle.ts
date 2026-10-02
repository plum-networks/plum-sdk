// Packaging and signing, byte-compatible with the box's trust package:
// META/MANIFEST.sha256 lists "<sha256hex>  <path>" for every non-META file,
// sorted by path bytes; META/publisher.pub, META/publisher.sig (signature over
// "plum-publisher-v1\n" + MANIFEST), optional META/recovery.pub with
// META/recovery.sig (signature over "plum-recovery-v1\n" + app id + "\n" +
// recovery key), and optional META/rotation.json.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { b64url, decodeSig, formatPublicKey, kid, parsePublicKey, PURPOSE_PUBLISHER, PURPOSE_RECOVERY, recoveryPayload, signPayload, verifyPayload, type PublisherKey, type Rotation } from './keys.js';
import { checkElf, MAX_BUNDLE_FILES, MAX_ENTRY_BYTES, MAX_PLU_BYTES, validateManifest, type Manifest, type Problem } from './manifest.js';
import { readZip, writeZip, type ZipEntry } from './zip.js';

export const META_DIR = 'META/';
export const META_MANIFEST = 'META/MANIFEST.sha256';
export const META_PUBLISHER = 'META/publisher.pub';
export const META_SIGNATURE = 'META/publisher.sig';
export const META_RECOVERY = 'META/recovery.pub';
/**
 * The publisher's signature over (app id, recovery key). MANIFEST covers only
 * the app's files, so META/recovery.pub on its own is signed by nobody: anyone
 * who re-zips a genuine bundle can swap it. A box therefore records a changed
 * recovery key from a direct install only when this verifies (plum-box-core
 * trust.RecoveryToRecord). Boxes that predate it ignore the entry.
 */
export const META_RECOVERY_SIG = 'META/recovery.sig';
export const META_ROTATION = 'META/rotation.json';

const SKIP_DIRS = new Set(['node_modules', '.git', 'META']);
// The box's caps on META/*.pub and META/*.sig (trust.maxKeyBytes / maxSigBytes).
const MAX_META_KEY_BYTES = 256;
const MAX_META_SIG_BYTES = 256;

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
  if (opts.recoveryPub) {
    if (opts.recoveryPub.length !== 32) throw new Error(`recovery key: ${opts.recoveryPub.length} bytes, want 32`);
    meta.push({ name: META_RECOVERY, data: Buffer.from(formatPublicKey(opts.recoveryPub) + '\n') });
    // Same rule as the box's own signer (trust.Signer.SignZip): sign the
    // recovery key whenever one is published and manifest.json names an id.
    const appId = manifestAppId(files);
    if (appId) {
      const rsig = signPayload(opts.key, PURPOSE_RECOVERY, recoveryPayload(appId, opts.recoveryPub));
      meta.push({ name: META_RECOVERY_SIG, data: Buffer.from(b64url.encode(rsig) + '\n') });
    }
  }
  if (opts.rotation) meta.push({ name: META_ROTATION, data: Buffer.from(JSON.stringify(opts.rotation, null, 2) + '\n') });
  const out = writeZip([...files, ...meta]);
  if (out.length > MAX_PLU_BYTES) throw new Error(`.plu is ${out.length} bytes; max ${MAX_PLU_BYTES}`);
  return out;
}

/** Re-signs an existing .plu (its META/ block is replaced). */
export function resignPlu(plu: Buffer, opts: SignOptions): Buffer {
  return signBundle(readZip(plu), opts);
}

/**
 * The app id META/recovery.sig is bound to: manifest.json's "id". '' when there
 * is no manifest.json, it is not a JSON object, or "id" is not a string — the
 * cases where the box's signer (trust.manifestAppID) writes no recovery.sig.
 */
export function manifestAppId(entries: ZipEntry[]): string {
  const m = entries.find((e) => e.name === 'manifest.json');
  if (!m) return '';
  try {
    const v = JSON.parse(m.data.toString('utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
    const id = (v as { id?: unknown }).id;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

/**
 * What a box makes of META/recovery.pub (trust.Bundle.RecoveryBound):
 * - 'signed':   META/recovery.sig verifies under META/publisher.pub for
 *               manifest.json's id — a box records this key even when it
 *               differs from the one on file;
 * - 'unsigned': no recovery.sig — a box adopts the key on a first install
 *               only, never as a change (unless the store vouches for the zip);
 * - 'invalid':  a recovery.sig that does not verify for this key, publisher
 *               and app id (a malformed one fails verification outright).
 */
export type RecoveryStatus = 'signed' | 'unsigned' | 'invalid';

/** trust.Bundle.RecoveryBound: sig is the publisher's over (manifest.json id, rec). */
function recoveryBound(pub: Buffer, rec: Buffer, sig: Buffer, files: ZipEntry[]): boolean {
  const appId = manifestAppId(files);
  return appId !== '' && verifyPayload(pub, PURPOSE_RECOVERY, recoveryPayload(appId, rec), sig);
}

function recoveryStatus(entries: ZipEntry[]): RecoveryStatus | undefined {
  const meta = new Map(entries.filter((e) => e.name.startsWith(META_DIR)).map((e) => [e.name, e.data]));
  const recText = meta.get(META_RECOVERY);
  if (!recText) return undefined;
  const sigText = meta.get(META_RECOVERY_SIG);
  if (!sigText) return 'unsigned';
  try {
    const pub = parsePublicKey(meta.get(META_PUBLISHER)?.toString('utf8') ?? '');
    const rec = parsePublicKey(recText.toString('utf8'));
    const files = entries.filter((e) => !e.name.startsWith(META_DIR));
    return recoveryBound(pub, rec, decodeSig(sigText.toString('utf8')), files) ? 'signed' : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Inspects a .plu: signer, recovery key (and whether it is signed), covered files, whether the signature verifies. */
export function inspectPlu(plu: Buffer): { publisher?: string; recovery?: string; recoverySig?: RecoveryStatus; files: string[]; signed: boolean } {
  const entries = readZip(plu);
  const meta = new Map(entries.filter((e) => e.name.startsWith(META_DIR)).map((e) => [e.name, e.data]));
  const files = entries.filter((e) => !e.name.startsWith(META_DIR)).map((e) => e.name).sort();
  const pub = meta.get(META_PUBLISHER)?.toString('utf8').trim();
  const rec = meta.get(META_RECOVERY)?.toString('utf8').trim();
  return {
    publisher: pub,
    recovery: rec,
    ...(rec !== undefined ? { recoverySig: recoveryStatus(entries) } : {}),
    files,
    signed: meta.has(META_SIGNATURE) && meta.has(META_MANIFEST) && !!pub,
  };
}

export type VerifyResult =
  | {
      ok: true;
      publisher: string;
      kid: string;
      files: number;
      /** META/recovery.pub, and whether META/recovery.sig binds it to this publisher and app id. */
      recovery?: { key: string; kid: string; signed: boolean };
    }
  | { ok: false; reason: string };

/**
 * Verifies a .plu the way the box does (signature + exact file coverage). Like
 * trust.VerifyZip, a malformed META/recovery.pub or META/recovery.sig fails
 * the whole bundle; one that is well-formed but does not verify only means the
 * recovery key is not bound (`recovery.signed: false`).
 */
export function verifyPlu(plu: Buffer): VerifyResult {
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
  const recText = meta.get(META_RECOVERY);
  const recSig = meta.get(META_RECOVERY_SIG);
  let rec: Buffer | undefined;
  if (recText) {
    if (recText.length > MAX_META_KEY_BYTES) return { ok: false, reason: `${META_RECOVERY} too large` };
    try {
      rec = parsePublicKey(recText.toString('utf8'));
    } catch (e) {
      return { ok: false, reason: `recovery key: ${(e as Error).message}` };
    }
  }
  let rsig: Buffer | undefined;
  if (recSig) {
    if (recSig.length > MAX_META_SIG_BYTES) return { ok: false, reason: `${META_RECOVERY_SIG} too large` };
    try {
      rsig = decodeSig(recSig.toString('utf8'));
    } catch (e) {
      return { ok: false, reason: `recovery signature: ${(e as Error).message}` };
    }
  }
  const out: VerifyResult & { ok: true } = { ok: true, publisher: formatPublicKey(pub), kid: kid(pub), files: files.size };
  if (rec) {
    const signed = !!rsig && recoveryBound(pub, rec, rsig, [...files].map(([name, data]) => ({ name, data })));
    out.recovery = { key: formatPublicKey(rec), kid: kid(rec), signed };
  }
  return out;
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
