// Escrow blobs: the publisher key file encrypted with a passphrase on this
// machine. Format (all base64url, dot-separated):
//   v1.scrypt.<salt 16B>.<nonce 12B>.<ciphertext+tag>
// scrypt N=2^15 r=8 p=1 → 32-byte key; AES-256-GCM with the version string as AAD.
// The store keeps the blob and cannot open it; losing the passphrase loses it.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const VERSION = 'v1.scrypt';
const N = 1 << 15;

function derive(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function sealEscrow(keyFile: Buffer, passphrase: string): string {
  if (passphrase.length < 8) throw new Error('escrow passphrase must be at least 8 characters');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', derive(passphrase, salt), nonce);
  c.setAAD(Buffer.from(VERSION));
  const ct = Buffer.concat([c.update(keyFile), c.final(), c.getAuthTag()]);
  return [VERSION, salt.toString('base64url'), nonce.toString('base64url'), ct.toString('base64url')].join('.');
}

export function openEscrow(blob: string, passphrase: string): Buffer {
  const parts = blob.trim().split('.');
  if (parts.length !== 5 || `${parts[0]}.${parts[1]}` !== VERSION) throw new Error('not a plum-dev escrow blob');
  const salt = Buffer.from(parts[2]!, 'base64url');
  const nonce = Buffer.from(parts[3]!, 'base64url');
  const ct = Buffer.from(parts[4]!, 'base64url');
  if (ct.length < 17) throw new Error('escrow blob truncated');
  const d = createDecipheriv('aes-256-gcm', derive(passphrase, salt), nonce);
  d.setAAD(Buffer.from(VERSION));
  d.setAuthTag(ct.subarray(ct.length - 16));
  try {
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    throw new Error('wrong passphrase (or the blob was altered)');
  }
}
