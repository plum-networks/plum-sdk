import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32, readZip, writeZip } from '../src/zip.js';

function hasBin(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('zip', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('round-trips stored and deflated entries', () => {
    const big = Buffer.alloc(100_000, 'a');
    const entries = [
      { name: 'manifest.json', data: Buffer.from('{"id":"x"}') },
      { name: 'dir/big.txt', data: big },
      { name: 'bin', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]) },
      { name: 'unicode/한글.txt', data: Buffer.from('안녕') },
    ];
    const zip = writeZip(entries);
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (let i = 0; i < entries.length; i++) expect(back[i]!.data.equals(entries[i]!.data)).toBe(true);
  });

  it('is deterministic', () => {
    const entries = [{ name: 'a', data: Buffer.from('hello') }, { name: 'b', data: Buffer.alloc(5000, 'z') }];
    expect(writeZip(entries).equals(writeZip(entries))).toBe(true);
  });

  it('is readable by the system unzip', () => {
    if (!hasBin('unzip')) return;
    const dir = mkdtempSync(join(tmpdir(), 'plumzip-'));
    const p = join(dir, 't.zip');
    writeFileSync(p, writeZip([{ name: 'x/y.txt', data: Buffer.from('payload') }, { name: 'z', data: Buffer.alloc(4000, 'q') }]));
    const out = execFileSync('unzip', ['-t', p]).toString();
    expect(out).toContain('No errors detected');
  });
});
