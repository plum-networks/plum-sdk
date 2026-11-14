// App icons. Plum Store refuses an app's first upload without one
// (plum-store app/icons.py): a PNG, square, 256–2048 px a side, at most 1 MiB.
// The store takes it from the upload's `icon` part or, failing that, from
// manifest.icon inside the bundle — which is what `plum-dev init` sets up.
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const ICON_MIN_PX = 256;
export const ICON_MAX_PX = 2048;
export const ICON_MAX_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Why the store would refuse this icon, or null if it would take it. Mirrors check_icon. */
export function iconProblem(data: Buffer): string | null {
  if (data.length === 0) return 'the icon file is empty';
  if (data.length > ICON_MAX_BYTES) return `the icon is ${data.length} bytes; at most ${ICON_MAX_BYTES} (1 MiB)`;
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.subarray(12, 16).toString('latin1') !== 'IHDR') {
    return 'the icon must be a PNG file';
  }
  const w = data.readUInt32BE(16);
  const h = data.readUInt32BE(20);
  if (w !== h) return `the icon is ${w}×${h}; it must be square`;
  if (w < ICON_MIN_PX || w > ICON_MAX_PX) return `the icon is ${w}×${h}; it must be ${ICON_MIN_PX}–${ICON_MAX_PX} px a side (512×512 is a good size)`;
  return null;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Inside a rounded square (corner radius r) of side s, top-left at (x0, y0)? */
function inRounded(x: number, y: number, x0: number, y0: number, s: number, r: number): boolean {
  if (x < x0 || y < y0 || x >= x0 + s || y >= y0 + s) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + s - r - 1);
  const cy = Math.min(Math.max(y, y0 + r), y0 + s - r - 1);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

let cached: Buffer | undefined;

/**
 * The stand-in icon `plum-dev init` writes: 512×512, a dark tile with four
 * light squares (an "app" mark). Deterministic, so `validate` can tell the
 * developer it is still the placeholder.
 */
export function placeholderIcon(): Buffer {
  if (cached) return cached;
  const size = 512;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const dark = [0x1c, 0x1c, 0x1e];
  const light = [0xf2, 0xf2, 0xf2];
  const cell = 104;
  const gap = 32;
  const start = (size - (cell * 2 + gap)) / 2;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 4;
      let px: number[] | null = null;
      if (inRounded(x, y, 0, 0, size, 112)) {
        px = dark;
        for (const [cx, cy] of [[start, start], [start + cell + gap, start], [start, start + cell + gap], [start + cell + gap, start + cell + gap]] as const) {
          if (inRounded(x, y, cx, cy, cell, 24)) px = light;
        }
      }
      if (px) {
        raw[o] = px[0]!;
        raw[o + 1] = px[1]!;
        raw[o + 2] = px[2]!;
        raw[o + 3] = 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  cached = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  return cached;
}

const placeholderDigest = () => createHash('sha256').update(placeholderIcon()).digest('hex');

export function isPlaceholderIcon(data: Buffer): boolean {
  return createHash('sha256').update(data).digest('hex') === placeholderDigest();
}
