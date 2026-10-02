import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkBundle, inspectPlu, manifestAppId, resignPlu, signBundle, verifyPlu } from '../src/bundle.js';
import {
  decodeSig, formatPublicKey, generateKey, kid, loadKey, makeRotation, PURPOSE_RECOVERY, recoveryPayload, saveKey, signPayload, verifyPayload,
  type PublisherKey,
} from '../src/keys.js';
import { checkElf, validateManifest } from '../src/manifest.js';
import { readZip, writeZip } from '../src/zip.js';

const GO_PLU = process.env.PLUM_GO_PLU ?? join(homedir(), '.local', 'bin', 'plu');

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
    expect(names).toEqual([
      'assets/b.css', 'index.html', 'manifest.json', 'svc',
      'META/MANIFEST.sha256', 'META/publisher.pub', 'META/publisher.sig', 'META/recovery.pub', 'META/recovery.sig',
    ]);
    expect(info.recoverySig).toBe('signed');
    expect(v.ok && v.recovery).toEqual({ key: formatPublicKey(rec.pub), kid: kid(rec.pub), signed: true });
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
    expect(readZip(second).some((e) => e.name === 'META/recovery.sig')).toBe(false);
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

// Ed25519 keys from a fixed seed (first, first+1, …), so a signature made here
// can be compared byte for byte with one made by the Go code from the same seed.
function keyFromSeed(first: number): PublisherKey {
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => (first + i) & 0xff));
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, pub: Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url') };
}

// Produced by plum-box-core's own signer — trust.Signer.SignZip, the code
// `plu sign` runs — with ed25519.NewKeyFromSeed over the seeds 0x01..0x20
// (publisher) and 0x80..0x9f (recovery) and the two files below. Ed25519 is
// deterministic, so the CLI has to produce exactly these bytes. Go side:
//
//   priv := ed25519.NewKeyFromSeed(seed(0x01)); rpub := ed25519.NewKeyFromSeed(seed(0x80)).Public()
//   (&Signer{Priv: priv, RecoveryPub: rpub}).SignZip(zip(GOLDEN_FILES), w)
//   VerifyZip(...).RecoveryBound("dev.alice.hello") == true, ("dev.alice.other") == false
const GOLDEN_FILES = [
  { name: 'manifest.json', data: Buffer.from('{"id":"dev.alice.hello","name":"Hello","version":"1.0.0"}') },
  { name: 'index.html', data: Buffer.from('<h1>hi</h1>') },
];
const GOLDEN_META: Record<string, string> = {
  'META/MANIFEST.sha256':
    'e7fbb6fbbf4ce294913eb62b53ff03a7546649cfdc0d824d9e3a2b4541502f7f  index.html\n' +
    '9427d1e0aeee5ae85ed8a65962093378de413227363945968accee15a214c11a  manifest.json\n',
  'META/publisher.pub': 'ed25519:ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ\n',
  'META/publisher.sig': 'adJDkEcg0rjlepVTNocI9M56H70j131Pvmcat0U7SkrI56f26Bosoe2scneACcH00nKUq-C8yz8lddiOWJrzCg\n',
  'META/recovery.pub': 'ed25519:zRSzf5VulTGU_3-3Oz2B3MVh1hp1OAlLfD4aZD7l86o\n',
  'META/recovery.sig': '4_VKAoGD3cDasAT-r57drjwR47eRDn5zTNGUMRXGFnf8botC8ze0nhXuxftgwUEwHAuPkKuj3Sno7Q4VxjMfBg\n',
};
// signingInput(PurposeRecovery, RecoveryPayload(appID, rpub)) on the Go side.
const GOLDEN_RECOVERY_INPUT = 'plum-recovery-v1\ndev.alice.hello\ned25519:zRSzf5VulTGU_3-3Oz2B3MVh1hp1OAlLfD4aZD7l86o';

function metaOf(plu: Buffer): Record<string, string> {
  return Object.fromEntries(readZip(plu).filter((e) => e.name.startsWith('META/')).map((e) => [e.name, e.data.toString('utf8')]));
}

function replaceEntry(plu: Buffer, name: string, data: string | null): Buffer {
  const parts = readZip(plu).filter((e) => e.name !== name);
  return writeZip(data === null ? parts : [...parts, { name, data: Buffer.from(data) }]);
}

describe('META/recovery.sig', () => {
  const pubKey = keyFromSeed(0x01);
  const recKey = keyFromSeed(0x80);

  it('matches the golden vector from plum-box-core byte for byte', () => {
    expect(formatPublicKey(pubKey.pub)).toBe(GOLDEN_META['META/publisher.pub']!.trim());
    expect(formatPublicKey(recKey.pub)).toBe(GOLDEN_META['META/recovery.pub']!.trim());
    const payload = recoveryPayload('dev.alice.hello', recKey.pub);
    expect(Buffer.concat([Buffer.from(PURPOSE_RECOVERY + '\n'), payload]).toString('utf8')).toBe(GOLDEN_RECOVERY_INPUT);

    const plu = signBundle(GOLDEN_FILES, { key: pubKey, recoveryPub: recKey.pub });
    expect(metaOf(plu)).toEqual(GOLDEN_META);
    // Same order as the Go signer writes them.
    expect(readZip(plu).map((e) => e.name).filter((n) => n.startsWith('META/'))).toEqual(Object.keys(GOLDEN_META));
    const v = verifyPlu(plu);
    expect(v.ok && v.recovery?.signed).toBe(true);
  });

  it('is bound to the app id and the recovery key, under the publisher key', () => {
    const sig = decodeSig(GOLDEN_META['META/recovery.sig']!);
    expect(verifyPayload(pubKey.pub, PURPOSE_RECOVERY, recoveryPayload('dev.alice.hello', recKey.pub), sig)).toBe(true);
    expect(verifyPayload(pubKey.pub, PURPOSE_RECOVERY, recoveryPayload('dev.alice.other', recKey.pub), sig)).toBe(false);
    expect(verifyPayload(pubKey.pub, PURPOSE_RECOVERY, recoveryPayload('dev.alice.hello', generateKey().pub), sig)).toBe(false);
    expect(verifyPayload(recKey.pub, PURPOSE_RECOVERY, recoveryPayload('dev.alice.hello', recKey.pub), sig)).toBe(false);
    // Purpose separation: the same bytes under another purpose do not verify.
    expect(verifyPayload(pubKey.pub, 'plum-publisher-v1', recoveryPayload('dev.alice.hello', recKey.pub), sig)).toBe(false);
  });

  it('a swapped recovery.pub still verifies as a bundle but is not signed; a stripped or garbled sig is caught', () => {
    const plu = signBundle(GOLDEN_FILES, { key: pubKey, recoveryPub: recKey.pub });
    const evil = generateKey();
    const swapped = replaceEntry(plu, 'META/recovery.pub', formatPublicKey(evil.pub) + '\n');
    const vs = verifyPlu(swapped);
    expect(vs.ok).toBe(true); // that is the problem recovery.sig solves
    expect(vs.ok && vs.recovery).toEqual({ key: formatPublicKey(evil.pub), kid: kid(evil.pub), signed: false });
    expect(inspectPlu(swapped).recoverySig).toBe('invalid');

    const stripped = replaceEntry(swapped, 'META/recovery.sig', null);
    const vt = verifyPlu(stripped);
    expect(vt.ok && vt.recovery?.signed).toBe(false);
    expect(inspectPlu(stripped).recoverySig).toBe('unsigned');

    // The box fails a malformed recovery.sig outright (trust.VerifyZip).
    for (const bad of ['not-a-signature', 'AAAA', GOLDEN_META['META/recovery.sig']!.trim() + '=', '!' + GOLDEN_META['META/recovery.sig']!.slice(1)]) {
      expect(verifyPlu(replaceEntry(plu, 'META/recovery.sig', bad))).toMatchObject({ ok: false, reason: expect.stringContaining('recovery signature') });
    }
    expect(verifyPlu(replaceEntry(plu, 'META/recovery.pub', 'ed25519:short'))).toMatchObject({ ok: false, reason: expect.stringContaining('recovery key') });
  });

  it('follows the Go signer: no manifest id, no recovery.sig; no recovery key, neither file', () => {
    const noId = [{ name: 'manifest.json', data: Buffer.from('{"name":"x"}') }, GOLDEN_FILES[1]!];
    expect(manifestAppId(noId)).toBe('');
    expect(Object.keys(metaOf(signBundle(noId, { key: pubKey, recoveryPub: recKey.pub })))).not.toContain('META/recovery.sig');
    expect(manifestAppId([{ name: 'manifest.json', data: Buffer.from('not json') }])).toBe('');
    expect(manifestAppId([{ name: 'manifest.json', data: Buffer.from('{"id":7}') }])).toBe('');
    expect(manifestAppId([{ name: 'manifest.json', data: Buffer.from('[1]') }])).toBe('');
    expect(Object.keys(metaOf(signBundle(GOLDEN_FILES, { key: pubKey })))).toEqual(['META/MANIFEST.sha256', 'META/publisher.pub', 'META/publisher.sig']);
    expect(() => signBundle(GOLDEN_FILES, { key: pubKey, recoveryPub: Buffer.alloc(31) })).toThrow(/32/);
  });

  it('re-signing a bundle that was signed for one recovery key binds the new one', () => {
    const other = keyFromSeed(0x40);
    const first = signBundle(GOLDEN_FILES, { key: pubKey, recoveryPub: recKey.pub });
    const second = resignPlu(first, { key: pubKey, recoveryPub: other.pub });
    const v = verifyPlu(second);
    expect(v.ok && v.recovery).toEqual({ key: formatPublicKey(other.pub), kid: kid(other.pub), signed: true });
  });
});

// Interop with the box's own implementation (cmd/plu from plum-box-core),
// when it is installed on this machine (PLUM_GO_PLU overrides the path).
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

  it.skipIf(!present)('plu sign -recovery writes the same META/ block, recovery.sig included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pluinterop-'));
    const k = generateKey();
    const rec = generateKey();
    saveKey(join(dir, 'k.key'), k);
    saveKey(join(dir, 'rec.key'), rec);
    writeFileSync(join(dir, 'raw.plu'), writeZip(entries()));
    execFileSync(GO_PLU, ['sign', '-key', join(dir, 'k.key'), '-recovery', join(dir, 'rec.key'), join(dir, 'raw.plu'), join(dir, 'go.plu')]);
    const goPlu = readFileSync(join(dir, 'go.plu'));
    const goMeta = metaOf(goPlu);
    if (!('META/recovery.sig' in goMeta)) return; // a plu that predates recovery.sig
    expect(metaOf(signBundle(entries(), { key: k, recoveryPub: rec.pub }))).toEqual(goMeta);
    const v = verifyPlu(goPlu);
    expect(v.ok && v.recovery?.signed).toBe(true);
  });
});

// The decisive check: hand bundles this CLI signed to plum-box-core's own
// verifier (trust.VerifyZip → Bundle.RecoveryBound → RecoveryToRecord) by
// compiling a throwaway test into its trust package with `go test -overlay`,
// which leaves the checkout untouched. Runs when a core checkout that knows
// recovery.sig is at $PLUM_CORE_DIR or next to this repo (../plum-box-core).
const CORE_DIR = [process.env.PLUM_CORE_DIR, fileURLToPath(new URL('../../../../plum-box-core', import.meta.url))].find(
  (d): d is string => !!d && existsSync(join(d, 'internal/apps/trust/recovery.go')) &&
    readFileSync(join(d, 'internal/apps/trust/recovery.go'), 'utf8').includes('RecoveryBound('),
);
const HAVE_GO = !spawnSync('go', ['version'], { stdio: 'ignore' }).error;

const CORE_INTEROP_TEST = `package trust

import (
	"archive/zip"
	"bytes"
	"os"
	"testing"
)

func sdkOpen(t *testing.T, env string) *Bundle {
	t.Helper()
	raw, err := os.ReadFile(os.Getenv(env))
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	b, err := VerifyZip(zr)
	if err != nil {
		t.Fatalf("%s: VerifyZip: %v", env, err)
	}
	return b
}

func TestPlumSDKRecoverySig(t *testing.T) {
	app := os.Getenv("SDK_APP_ID")
	b := sdkOpen(t, "SDK_SIGNED")
	if b.Recovery == nil || b.Recovery.KID != os.Getenv("SDK_RECOVERY_KID") || len(b.RecoverySig) == 0 {
		t.Fatalf("recovery key or signature missing: %+v", b.Recovery)
	}
	if !b.RecoveryBound(app) {
		t.Fatal("recovery.sig written by the SDK does not bind the key")
	}
	if b.RecoveryBound(app + "x") {
		t.Fatal("bound to another app id")
	}
	// A direct install that changes the recovery key on record adopts it.
	if kid, ignored := RecoveryToRecord(&Installed{PublisherKID: b.Publisher.KID, RecoveryKID: "pub-0000000000000000"}, b, app, false); ignored || kid != b.Recovery.KID {
		t.Fatalf("RecoveryToRecord: got (%q, %v)", kid, ignored)
	}
	sw := sdkOpen(t, "SDK_SWAPPED")
	if sw.RecoveryBound(app) {
		t.Fatal("a swapped recovery.pub is bound")
	}
	if _, ignored := RecoveryToRecord(&Installed{PublisherKID: sw.Publisher.KID, RecoveryKID: "pub-0000000000000000"}, sw, app, false); !ignored {
		t.Fatal("a swapped recovery.pub was recorded")
	}
}
`;

describe('interop with the box verifier (plum-box-core trust package)', () => {
  it.skipIf(!CORE_DIR || !HAVE_GO)('the box binds a recovery key this CLI signed, and not a swapped one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plucore-'));
    const k = generateKey();
    const rec = generateKey();
    const plu = signBundle(entries(), { key: k, recoveryPub: rec.pub });
    writeFileSync(join(dir, 'signed.plu'), plu);
    writeFileSync(join(dir, 'swapped.plu'), replaceEntry(plu, 'META/recovery.pub', formatPublicKey(generateKey().pub) + '\n'));
    writeFileSync(join(dir, 'sdk_interop_test.go'), CORE_INTEROP_TEST);
    const virtual = join(CORE_DIR!, 'internal/apps/trust/zz_plum_sdk_interop_test.go');
    writeFileSync(join(dir, 'overlay.json'), JSON.stringify({ Replace: { [virtual]: join(dir, 'sdk_interop_test.go') } }));
    const r = spawnSync('go', ['test', '-count=1', '-overlay', join(dir, 'overlay.json'), '-run', '^TestPlumSDKRecoverySig$', '-v', './internal/apps/trust'], {
      cwd: CORE_DIR,
      encoding: 'utf8',
      env: {
        ...process.env,
        SDK_APP_ID: manifest.id,
        SDK_RECOVERY_KID: kid(rec.pub),
        SDK_SIGNED: join(dir, 'signed.plu'),
        SDK_SWAPPED: join(dir, 'swapped.plu'),
      },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('--- PASS: TestPlumSDKRecoverySig');
  }, 180_000);
});

describe('SDK usage vs declared permissions', () => {
  it('warns when a page calls an SDK namespace the manifest does not declare', () => {
    const m = { ...manifest, permissions: ['service:call'] };
    const files = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(m)) },
      { name: 'index.html', data: Buffer.from('<script>plum.user.current(); plum.service.fetch("/x"); plum.files.openPicker()</script>') },
      { name: 'svc', data: elf(0xb7) },
    ];
    const { problems } = checkBundle(files);
    const msgs = problems.filter((p) => p.level === 'warning').map((p) => p.message);
    expect(msgs.some((x) => x.includes('"user:profile"'))).toBe(true);
    expect(msgs.some((x) => x.includes('"files:read"'))).toBe(true);
    expect(msgs.some((x) => x.includes('"service:call"'))).toBe(false);
  });
});

describe('escrow', () => {
  it('seals and opens a key file with a passphrase, and rejects a wrong one', async () => {
    const { openEscrow, sealEscrow } = await import('../src/escrow.js');
    const key = Buffer.from('plum-key-v1\n' + 'x'.repeat(86) + '\n');
    const blob = sealEscrow(key, 'correct horse battery');
    expect(blob.startsWith('v1.scrypt.')).toBe(true);
    expect(sealEscrow(key, 'correct horse battery')).not.toBe(blob); // fresh salt/nonce
    expect(openEscrow(blob, 'correct horse battery').equals(key)).toBe(true);
    expect(() => openEscrow(blob, 'wrong')).toThrow(/passphrase/);
    expect(() => openEscrow(blob.slice(0, -4) + 'AAAA', 'correct horse battery')).toThrow();
    expect(() => sealEscrow(key, 'short')).toThrow(/8 characters/);
  });
});
