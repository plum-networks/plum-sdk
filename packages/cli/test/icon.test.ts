import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { iconProblem, isPlaceholderIcon, placeholderIcon } from '../src/icon.js';

function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return Buffer.concat([b, deflateSync(Buffer.alloc(1))]);
}

describe('app icons', () => {
  it('the placeholder is a 512×512 PNG the store accepts', () => {
    const p = placeholderIcon();
    expect(iconProblem(p)).toBeNull();
    expect(p.readUInt32BE(16)).toBe(512);
    expect(isPlaceholderIcon(p)).toBe(true);
    expect(placeholderIcon().equals(p)).toBe(true); // deterministic
  });
  it('mirrors the store\'s rules', () => {
    expect(iconProblem(Buffer.from('GIF89a…'))).toMatch(/PNG/);
    expect(iconProblem(pngHeader(512, 256))).toMatch(/square/);
    expect(iconProblem(pngHeader(128, 128))).toMatch(/256–2048/);
    expect(iconProblem(pngHeader(4096, 4096))).toMatch(/256–2048/);
    expect(iconProblem(pngHeader(1024, 1024))).toBeNull();
    expect(isPlaceholderIcon(pngHeader(512, 512))).toBe(false);
  });
});
