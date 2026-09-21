// `plum-dev build`: the Go path really compiles (skipped with a message when
// Go is absent), the Docker path refuses clearly when Docker is not there, and
// anything that is not a static arm64 ELF is refused whatever produced it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, checkServerBinary, detectKind, dockerfileFor, elfInterpreter, TARGET } from '../src/build.js';

const HAVE_GO = !spawnSync('go', ['version'], { stdio: 'ignore' }).error;

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'plumbuild-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const MANIFEST = JSON.stringify({
  id: 'dev.tester.built', name: 'Built', version: '0.1.0', entry: 'index.html',
  permissions: ['service:call'], server: { bin: 'svc', healthPath: '/healthz' },
}, null, 2);

/** A minimal 64-bit LE ELF header, optionally with a PT_INTERP (= dynamic). */
function elf(machine: number, interp?: string): Buffer {
  const phoff = 64, phentsize = 56, phnum = interp ? 1 : 0;
  const strAt = phoff + phentsize * phnum;
  const b = Buffer.alloc(Math.max(strAt + (interp ? interp.length + 1 : 0), 64));
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46; // \x7fELF
  b[4] = 2; b[5] = 1; b[6] = 1; // 64-bit, little endian, v1
  b.writeUInt16LE(2, 16); // ET_EXEC
  b.writeUInt16LE(machine, 18);
  b.writeBigUInt64LE(BigInt(phoff), 32);
  b.writeUInt16LE(phentsize, 54);
  b.writeUInt16LE(phnum, 56);
  if (interp) {
    b.writeUInt32LE(3, phoff); // PT_INTERP
    b.writeUInt32LE(4, phoff + 4);
    b.writeBigUInt64LE(BigInt(strAt), phoff + 8);
    b.writeBigUInt64LE(BigInt(interp.length + 1), phoff + 32);
    b.write(interp + '\0', strAt);
  }
  return b;
}

describe('the ELF gate', () => {
  it('accepts a static arm64 ELF', () => {
    expect(checkServerBinary(elf(0xb7), 'svc')).toBeNull();
    expect(elfInterpreter(elf(0xb7))).toBeNull();
  });

  it('names the architecture it found', () => {
    expect(checkServerBinary(elf(0x3e), 'svc')!.message).toMatch(/svc is built for ELF machine 0x3e.*arm64/);
    expect(checkServerBinary(Buffer.alloc(200), 'svc')!.message).toMatch(/not an ELF/);
  });

  it('names the interpreter of a dynamically linked binary', () => {
    const p = checkServerBinary(elf(0xb7, '/lib/ld-linux-aarch64.so.1'), 'svc')!;
    expect(p.level).toBe('error');
    expect(p.message).toContain('/lib/ld-linux-aarch64.so.1');
    expect(p.message).toContain('CGO_ENABLED=0');
  });

  it('refuses whatever the build produced when it is not that', async () => {
    const dir = app({ 'manifest.json': MANIFEST, 'index.html': '<html></html>', 'server/go.mod': 'module x\n\ngo 1.22\n' });
    // A "toolchain" that writes an x86-64 binary: the build must not pass it on.
    await expect(build({
      dir,
      run: (_cmd, args) => {
        writeFileSync(args[args.indexOf('-o') + 1]!, elf(0x3e));
        return { status: 0 };
      },
    })).rejects.toThrow(/0x3e/);
  });
});

describe('the Go path', () => {
  it.skipIf(!HAVE_GO)('cross-compiles server/ to the binary the manifest names, without Docker', async () => {
    const dir = app({
      'manifest.json': MANIFEST,
      'index.html': '<html></html>',
      'server/go.mod': 'module dev.tester.built/server\n\ngo 1.21\n',
      'server/main.go': 'package main\n\nimport "os"\n\nfunc main() { os.Exit(0) }\n',
    });
    expect(detectKind(dir)).toEqual({ kind: 'go', source: 'server' });
    const lines: string[] = [];
    const r = await build({ dir, log: (l) => lines.push(l) });
    expect(r.kind).toBe('go');
    expect(r.source).toBe('server');
    expect(r.out).toBe(join(dir, 'svc'));
    expect(lines.join('\n')).toContain('no Docker needed');
    const bin = readFileSync(r.out);
    expect(checkServerBinary(bin, 'svc')).toBeNull();
    expect(bin.readUInt16LE(18)).toBe(0xb7); // EM_AARCH64
  }, 180_000);

  it(HAVE_GO ? 'passes the cross-compile environment to go build' : 'passes the cross-compile environment (go not on PATH: the real build is skipped)', async () => {
    const dir = app({ 'manifest.json': MANIFEST, 'index.html': '<html></html>', 'go.mod': 'module x\n\ngo 1.22\n' });
    let seen: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv } | null = null;
    await build({
      dir,
      run: (cmd, args, opts) => {
        seen = { cmd, args, env: opts.env };
        writeFileSync(args[args.indexOf('-o') + 1]!, elf(0xb7));
        return { status: 0 };
      },
    });
    const got = seen as unknown as { cmd: string; args: string[]; env: NodeJS.ProcessEnv };
    expect(got.cmd).toBe('go');
    expect(got.args).toEqual(['build', '-trimpath', '-ldflags=-s -w', '-o', join(dir, 'svc'), '.']);
    expect(got.env.CGO_ENABLED).toBe('0');
    expect(got.env.GOOS).toBe(TARGET.goos);
    expect(got.env.GOARCH).toBe(TARGET.goarch);
  });

  it('reports a compiler failure without inventing a reason', async () => {
    const dir = app({ 'manifest.json': MANIFEST, 'index.html': '<html></html>', 'server/go.mod': 'module x\n\ngo 1.22\n' });
    await expect(build({ dir, run: () => ({ status: 2 }) })).rejects.toThrow(/go build failed \(exit 2\)/);
  });
});

describe('the Docker path', () => {
  it('refuses clearly when Docker is not available, naming the binary it wanted', async () => {
    const dir = app({ 'manifest.json': MANIFEST, 'index.html': '<html></html>', 'server/Cargo.toml': '[package]\nname = "svc"\n' });
    expect(detectKind(dir)).toEqual({ kind: 'rust', source: 'server' });
    await expect(build({ dir, docker: false })).rejects.toThrow(/needs Docker/);
    await expect(build({ dir, docker: false })).rejects.toThrow(new RegExp(join(dir, 'svc').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(build({ dir, docker: false })).rejects.toThrow(/Go services need no Docker/);
    expect(existsSync(join(dir, 'svc'))).toBe(false);
  });

  it('builds for linux/arm64 and takes /svc out of the final stage', async () => {
    const dir = app({ 'manifest.json': MANIFEST, 'index.html': '<html></html>', 'server/Cargo.toml': '[package]\nname = "svc"\n' });
    let args: string[] = [];
    await build({
      dir,
      docker: true,
      run: (_cmd, a) => {
        args = a;
        const dest = a[a.indexOf('--output') + 1]!.replace('type=local,dest=', '');
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, 'svc'), elf(0xb7));
        return { status: 0 };
      },
    });
    expect(args.slice(0, 4)).toEqual(['buildx', 'build', '--platform', TARGET.platform]);
    expect(readFileSync(join(dir, 'svc')).readUInt16LE(18)).toBe(0xb7);
  });

  it('says so when the image has no /svc', async () => {
    const dir = app({ 'manifest.json': MANIFEST, 'index.html': '<html></html>', 'server/build.zig': '// zig\n' });
    expect(dockerfileFor('zig')).toContain('aarch64-linux-musl');
    await expect(build({ dir, docker: true, run: () => ({ status: 0 }) })).rejects.toThrow(/no \/svc/);
  });
});

describe('what build refuses to guess', () => {
  it('a panel has nothing to build', async () => {
    const dir = app({ 'manifest.json': JSON.stringify({ id: 'dev.t.panel', name: 'P', version: '1' }), 'index.html': '<html></html>' });
    await expect(build({ dir })).rejects.toThrow(/no server in manifest.json/);
  });

  it('an unknown toolchain is named, with the templates that exist', async () => {
    const dir = app({ 'manifest.json': MANIFEST, 'index.html': '<html></html>', 'server/main.rb': 'puts 1\n' });
    await expect(build({ dir })).rejects.toThrow(/cannot tell how to build[\s\S]*--template go\|rust\|zig\|dockerfile/);
  });
});
