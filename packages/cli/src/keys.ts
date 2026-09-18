// Publisher keys, byte-compatible with the box's Go implementation
// (plum-box-core internal/apps/trust): Ed25519, key files "plum-key-v1\n" +
// base64url(64-byte private key = seed || public), public keys rendered as
// "ed25519:<base64url raw 32 bytes>", KID = "pub-" + sha256(raw)[0:16 hex].
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const PURPOSE_PUBLISHER = 'plum-publisher-v1';
export const PURPOSE_ROTATION = 'plum-rotation-v1';
const KEY_FILE_PREFIX = 'plum-key-v1\n';

export const b64url = {
  encode: (b: Uint8Array): string => Buffer.from(b).toString('base64url'),
  decode: (s: string): Buffer => Buffer.from(s, 'base64url'),
};

export interface PublisherKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** raw 32-byte public key */
  pub: Buffer;
}

function rawPublic(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return b64url.decode(jwk.x);
}

function rawSeed(privateKey: KeyObject): Buffer {
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return b64url.decode(jwk.d);
}

export function generateKey(): PublisherKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, pub: rawPublic(publicKey) };
}

export function formatPublicKey(pub: Buffer): string {
  return 'ed25519:' + b64url.encode(pub);
}

export function parsePublicKey(s: string): Buffer {
  const t = s.trim();
  if (!t.startsWith('ed25519:')) throw new Error('public key: expected "ed25519:" prefix');
  const raw = b64url.decode(t.slice(8));
  if (raw.length !== 32) throw new Error(`public key: ${raw.length} bytes, want 32`);
  return raw;
}

export function kid(pub: Buffer): string {
  return 'pub-' + createHash('sha256').update(pub).digest('hex').slice(0, 16);
}

export function saveKey(path: string, key: PublisherKey): void {
  const priv64 = Buffer.concat([rawSeed(key.privateKey), key.pub]);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, KEY_FILE_PREFIX + b64url.encode(priv64) + '\n', { mode: 0o600 });
}

export function loadKey(path: string): PublisherKey {
  if (!existsSync(path)) throw new Error(`key file not found: ${path} (run: plum-dev keygen)`);
  const raw = readFileSync(path, 'utf8');
  const body = raw.startsWith(KEY_FILE_PREFIX) ? raw.slice(KEY_FILE_PREFIX.length) : raw;
  const priv64 = b64url.decode(body.trim());
  if (priv64.length !== 64) throw new Error(`${path}: not a plum-key-v1 file`);
  const seed = priv64.subarray(0, 32);
  const pub = priv64.subarray(32);
  const privateKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: b64url.encode(seed), x: b64url.encode(pub) },
    format: 'jwk',
  });
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, pub: Buffer.from(pub) };
}

function signingInput(purpose: string, payload: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(purpose + '\n', 'utf8'), payload]);
}

export function signPayload(key: PublisherKey, purpose: string, payload: Uint8Array): Buffer {
  return sign(null, signingInput(purpose, payload), key.privateKey);
}

export function verifyPayload(pub: Buffer, purpose: string, payload: Uint8Array, sig: Uint8Array): boolean {
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url.encode(pub) }, format: 'jwk' });
  return verify(null, signingInput(purpose, payload), publicKey, sig);
}

export interface Rotation {
  app_id: string;
  old_pub: string;
  new_pub: string;
  issued_at: number;
  signer: 'old' | 'recovery';
  recovery_pub?: string;
  sig: string;
}

function rotationPayload(r: Omit<Rotation, 'sig'>): Buffer {
  return Buffer.from(
    [r.app_id, r.old_pub, r.new_pub, String(r.issued_at), r.signer, r.recovery_pub ?? '', ''].join('\n'),
    'utf8',
  );
}

/** Builds a rotation record moving appId from oldPub to the new key. */
export function makeRotation(appId: string, oldPub: Buffer, newKey: PublisherKey, signer: PublisherKey, mode: 'old' | 'recovery'): Rotation {
  const base: Omit<Rotation, 'sig'> = {
    app_id: appId,
    old_pub: formatPublicKey(oldPub),
    new_pub: formatPublicKey(newKey.pub),
    issued_at: Math.floor(Date.now() / 1000),
    signer: mode,
  };
  if (mode === 'recovery') base.recovery_pub = formatPublicKey(signer.pub);
  const sig = signPayload(signer, PURPOSE_ROTATION, rotationPayload(base));
  return { ...base, sig: b64url.encode(sig) };
}
