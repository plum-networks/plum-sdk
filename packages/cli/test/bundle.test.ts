import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBundle, inspectPlu, resignPlu, signBundle, verifyPlu } from '../src/bundle.js';
import { formatPublicKey, generateKey, kid, loadKey, makeRotation, saveKey, signPayload, verifyPayload } from '../src/keys.js';
import { checkElf, validateManifest } from '../src/manifest.js';
import { readZip, writeZip } from '../src/zip.js';

const GO_PLU = join(homedir(), '.local', 'bin', 'plu');

function elf(machine: number): Buffer {
  const b = Buffer.alloc(64);
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46; b[4] = 2; b[5] = 1;
  b.writeUInt16LE(2, 16);
  b.writeUInt16LE(machine, 18);
  return b;
}

const manifest = { id: 'dev.alice.hello', name: 'Hello', version: '1.0.0', permissions: ['service:call'], server: { bin: 'svc', healthPath: '/healthz' } };

function entries() {
  return [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'index.html', data: Buffer.from('<html></html>') },
    { name: 'svc', data: elf(0xb7) },
    { name: 'assets/b.css', data: Buffer.from('body{}') },
  ];
}

describe('keys', () => {
  it('signs and verifies with the publisher purpose', () => {
    const k = generateKey();
    const sig = signPayload(k, 'plum-publisher-v1', Buffer.from('abc'));
    expect(sig.length).toBe(64);
    expect(verifyPayload(k.pub, 'plum-publisher-v1', Buffer.from('abc'), sig)).toBe(true);
    expect(verifyPayload(k.pub, 'plum-rotation-v1', Buffer.from('abc'), sig)).toBe(false);
  });

  it('round-trips the plum-key-v1 file format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plumkey-'));
    const k = generateKey();
    saveKey(join(dir, 'k.key'), k);
    const text = readFileSync(join(dir, 'k.key'), 'utf8');
    expect(text.startsWith('plum-key-v1\n')).toBe(true);
    const back = loadKey(join(dir, 'k.key'));
    expect(back.pub.equals(k.pub)).toBe(true);
    const sig = signPayload(back, 'p', Buffer.from('x'));
    expect(verifyPayload(k.pub, 'p', Buffer.from('x'), sig)).toBe(true);
    expect(kid(k.pub)).toMatch(/^pub-[0-9a-f]{16}$/);
  });
});

describe('bundle', () => {
  it('signs, verifies and covers every file', () => {
    const k = generateKey();
    const rec = generateKey();
    const plu = signBundle(entries(), { key: k, recoveryPub: rec.pub });
    const v = verifyPlu(plu);
    expect(v.ok).toBe(true);
    if (v.ok) { expect(v.kid).toBe(kid(k.pub)); expect(v.files).toBe(4); }
    const info = inspectPlu(plu);
    expect(info.publisher).toBe(formatPublicKey(k.pub));
    expect(info.recovery).toBe(formatPublicKey(rec.pub));
    const names = readZip(plu).map((e) => e.name);
    expect(names).toEqual(['assets/b.css', 'index.html', 'manifest.json', 'svc', 'META/MANIFEST.sha256', 'META/publisher.pub', 'META/publisher.sig', 'META/recovery.pub']);
    const man = readZip(plu).find((e) => e.name === 'META/MANIFEST.sha256')!.data.toString();
    expect(man.split('\n').filter(Boolean).every((l) => /^[0-9a-f]{64}  \S/.test(l))).toBe(true);
  });

  it('is deterministic', () => {
    const k = generateKey();
    // Ed25519 is deterministic, so same key + same files = identical bytes.
    expect(signBundle(entries(), { key: k }).equals(signBundle(entries(), { key: k }))).toBe(true);
  });

  it('rejects tampering, additions and removals', () => {
    const k = generateKey();
    const plu = signBundle(entries(), { key: k });
    const parts = readZip(plu);
    const tampered = writeZip(parts.map((e) => (e.name === 'index.html' ? { ...e, data: Buffer.from('<html>evil</html>') } : e)));
    expect(verifyPlu(tampered)).toMatchObject({ ok: false, reason: expect.stringContaining('does not match') });
    const added = writeZip([...parts, { name: 'extra.js', data: Buffer.from('x') }]);
    expect(verifyPlu(added)).toMatchObject({ ok: false, reason: expect.stringContaining('not covered') });
    const removed = writeZip(parts.filter((e) => e.name !== 'svc'));
    expect(verifyPlu(removed)).toMatchObject({ ok: false, reason: expect.stringContaining('missing') });
    expect(verifyPlu(writeZip(entries()))).toMatchObject({ ok: false, reason: expect.stringContaining('unsigned') });
  });

  it('re-signing replaces META and drops the old signer', () => {
    const k1 = generateKey();
    const k2 = generateKey();
    const first = signBundle(entries(), { key: k1, recoveryPub: generateKey().pub });
    const second = resignPlu(first, { key: k2 });
    const v = verifyPlu(second);
    expect(v.ok && v.kid).toBe(kid(k2.pub));
    expect(inspectPlu(second).recovery).toBeUndefined();
  });

  it('checkBundle mirrors the box rules', () => {
    const ok = checkBundle(entries());
    expect(ok.problems.filter((p) => p.level === 'error')).toEqual([]);
    const missingEntry = checkBundle(entries().filter((e) => e.name !== 'index.html'));
    expect(missingEntry.problems.some((p) => p.message.includes('entry "index.html"'))).toBe(true);
    const x86 = checkBundle(entries().map((e) => (e.name === 'svc' ? { ...e, data: elf(0x3e) } : e)));
    expect(x86.problems.some((p) => p.level === 'error' && p.message.includes('arm64'))).toBe(true);
    const host = checkBundle(entries().map((e) => (e.name === 'svc' ? { ...e, data: elf(0x3e) } : e)), true);
    expect(host.problems.some((p) => p.level === 'warning' && p.message.includes('emulator'))).toBe(true);
    const badPerm = validateManifest(Buffer.from(JSON.stringify({ ...manifest, permissions: ['photos:all'] })));
    expect(badPerm.problems.some((p) => p.message.includes('unknown permission'))).toBe(true);
    const badId = validateManifest(Buffer.from(JSON.stringify({ ...manifest, id: 'Bad Id' })));
    expect(badId.problems.some((p) => p.message.includes('must match'))).toBe(true);
    const badLimit = validateManifest(Buffer.from(JSON.stringify({ ...manifest, server: { bin: 'svc', limits: { memory: 'lots', cpu: 900 } } })));
    expect(badLimit.problems.filter((p) => p.level === 'error').length).toBe(2);
    expect(checkElf(Buffer.from('not elf'))).toMatchObject({ level: 'error' });
  });

  it('rotation records carry a verifiable signature', () => {
    const oldKey = generateKey();
    const newKey = generateKey();
    const rec = generateKey();
    const r1 = makeRotation('dev.alice.hello', oldKey.pub, newKey, oldKey, 'old');
    expect(r1.signer).toBe('old');
    expect(r1.recovery_pub).toBeUndefined();
    const r2 = makeRotation('dev.alice.hello', oldKey.pub, newKey, rec, 'recovery');
    expect(r2.recovery_pub).toBe(formatPublicKey(rec.pub));
    const plu = signBundle(entries(), { key: newKey, rotation: r2 });
    expect(readZip(plu).some((e) => e.name === 'META/rotation.json')).toBe(true);
  });
});

// Interop with the box's own implementation (cmd/plu from plum-box-core),
// when it is installed on this machine.
describe('interop with the Go plu tool', () => {
  const present = existsSync(GO_PLU);
  it.skipIf(!present)('a CLI-signed bundle verifies with plu verify, and keys are interchangeable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pluinterop-'));
    const k = generateKey();
    const rec = generateKey();
    saveKey(join(dir, 'k.key'), k);
    const goPub = execFileSync(GO_PLU, ['pubkey', '-key', join(dir, 'k.key')]).toString().split('\n')[0];
    expect(goPub).toBe(formatPublicKey(k.pub));

    const oldKey = generateKey();
    const rot = makeRotation('dev.alice.hello', oldKey.pub, k, rec, 'recovery');
    const plu = signBundle(entries(), { key: k, recoveryPub: rec.pub, rotation: rot });
    writeFileSync(join(dir, 'a.plu'), plu);
    const out = execFileSync(GO_PLU, ['verify', join(dir, 'a.plu')]).toString();
    expect(out).toContain(kid(k.pub));

    // And the other way round: a Go-signed bundle verifies here.
    writeFileSync(join(dir, 'raw.plu'), writeZip(entries()));
    execFileSync(GO_PLU, ['sign', '-key', join(dir, 'k.key'), join(dir, 'raw.plu'), join(dir, 'go.plu')]);
    const v = verifyPlu(readFileSync(join(dir, 'go.plu')));
    expect(v.ok && v.kid).toBe(kid(k.pub));
  });
});
