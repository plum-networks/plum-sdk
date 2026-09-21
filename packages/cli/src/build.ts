// `plum-dev build [dir]` — produce the service binary the manifest names.
//
// The box runs arm64 and nothing else, and the ELF gate refuses anything that
// is not a static arm64 binary. Working that out per language is exactly the
// kind of thing a developer should not have to do:
//
//   Go        a plain cross-compile (CGO_ENABLED=0 GOOS=linux GOARCH=arm64).
//             No Docker, no container, a couple of seconds.
//   anything  `docker buildx build --platform linux/arm64` with a small
//   else      generated Dockerfile whose final stage holds the binary at /svc.
//             This is the one place in the CLI where Docker is really needed.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { dockerAvailable } from './emulator.js';
import { checkElf, type Manifest, type Problem } from './manifest.js';

export type BuildKind = 'go' | 'rust' | 'zig' | 'dockerfile';
export const BUILD_KINDS: readonly BuildKind[] = ['go', 'rust', 'zig', 'dockerfile'];

/** The arm64 target every box binary is built for. */
export const TARGET = { goos: 'linux', goarch: 'arm64', platform: 'linux/arm64' } as const;

export interface RunResult { status: number | null; error?: Error }
export type Runner = (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => RunResult;

const realRunner: Runner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: 'inherit' });
  return { status: r.status, ...(r.error ? { error: r.error } : {}) };
};

export interface BuildOptions {
  dir: string;
  /** Force a toolchain instead of detecting one. */
  kind?: BuildKind;
  /** A Dockerfile to use verbatim (its final stage must hold the binary at /svc). */
  dockerfile?: string;
  /** Override the Docker probe (tests, and `--no-docker`). */
  docker?: boolean;
  log?: (s: string) => void;
  run?: Runner;
}

export interface BuildResult {
  kind: BuildKind;
  /** Where the binary landed (absolute). */
  out: string;
  /** The directory the toolchain ran in, relative to the app dir. */
  source: string;
  bytes: number;
}

// ------------------------------------------------------------------ the ELF

/** The PT_INTERP of a 64-bit ELF: a dynamic binary names its loader, a static one has none. */
export function elfInterpreter(bin: Buffer): string | null {
  if (bin.length < 64) return null;
  const phoff = Number(bin.readBigUInt64LE(32));
  const phentsize = bin.readUInt16LE(54);
  const phnum = bin.readUInt16LE(56);
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (off + 56 > bin.length) break;
    if (bin.readUInt32LE(off) !== 3) continue; // PT_INTERP
    const at = Number(bin.readBigUInt64LE(off + 8));
    const len = Number(bin.readBigUInt64LE(off + 32));
    if (at + len > bin.length) return '(unreadable)';
    return bin.subarray(at, at + len).toString('utf8').replace(/\0+$/, '');
  }
  return null;
}

/**
 * The gate `validate` applies (checkElf), plus the part a build can get wrong
 * on its own: a binary that needs a loader the box does not have.
 */
export function checkServerBinary(bin: Buffer, name: string): Problem | null {
  const arch = checkElf(bin);
  if (arch) return { level: 'error', message: arch.message.replace(/^server\.bin/, name) };
  const interp = elfInterpreter(bin);
  if (interp) {
    return {
      level: 'error',
      message: `${name} is a dynamically linked ELF (it needs ${interp}); the box has no shared libraries for apps. Build it static: Go CGO_ENABLED=0, Rust --target aarch64-unknown-linux-musl, C/Zig -static.`,
    };
  }
  return null;
}

export function describeBinary(bin: Buffer): string {
  return `static arm64 ELF, ${(bin.length / (1024 * 1024)).toFixed(1)} MB`;
}

// ------------------------------------------------------------------ detect

function readManifest(dir: string): Manifest {
  const p = join(dir, 'manifest.json');
  if (!existsSync(p)) throw new Error(`${p}: not found — run plum-dev build inside an app directory (or pass one)`);
  return JSON.parse(readFileSync(p, 'utf8')) as Manifest;
}

const MARKER: Record<BuildKind, string> = { go: 'go.mod', rust: 'Cargo.toml', zig: 'build.zig', dockerfile: 'Dockerfile.plum' };

/** Where the toolchain should run: the app's server/ subdirectory, or the app root. */
export function detectKind(dir: string): { kind: BuildKind; source: string } | null {
  for (const sub of ['server', '.']) {
    const at = join(dir, sub);
    if (!existsSync(at)) continue;
    for (const kind of BUILD_KINDS) if (existsSync(join(at, MARKER[kind]))) return { kind, source: sub };
  }
  return null;
}

/** The subdirectory holding this toolchain's sources ("server" or "."). */
export function sourceFor(dir: string, kind: BuildKind): string {
  for (const sub of ['server', '.']) if (existsSync(join(dir, sub, MARKER[kind]))) return sub;
  return existsSync(join(dir, 'server')) ? 'server' : '.';
}

// -------------------------------------------------------------- dockerfiles

/**
 * One small Dockerfile per toolchain. Each ends in a scratch stage holding the
 * binary at /svc, so `--output type=local` drops exactly one file on the host.
 */
export function dockerfileFor(kind: BuildKind): string {
  if (kind === 'rust') {
    // The build stage runs as arm64 (emulated on an amd64 laptop), so the musl
    // toolchain is the native one and the result is static without cross setup.
    return `FROM rust:alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY . .
RUN cargo build --release --locked || cargo build --release
RUN mkdir -p /out && cp "$(find target/release -maxdepth 1 -type f -perm -u+x ! -name '*.d' | head -1)" /out/svc
FROM scratch
COPY --from=build /out/svc /svc
`;
  }
  if (kind === 'zig') {
    // Zig cross-compiles by itself, so this stage stays on the build host.
    return `FROM --platform=$BUILDPLATFORM alpine:3 AS build
RUN apk add --no-cache zig
WORKDIR /src
COPY . .
RUN zig build -Dtarget=aarch64-linux-musl -Doptimize=ReleaseSafe
RUN mkdir -p /out && cp "$(find zig-out/bin -maxdepth 1 -type f | head -1)" /out/svc
FROM scratch
COPY --from=build /out/svc /svc
`;
  }
  throw new Error(`no generated Dockerfile for "${kind}"`);
}

export function dockerMissing(kind: BuildKind, bin: string): string {
  return `a ${kind} service has to be cross-built for ${TARGET.platform}, and that needs Docker — which is not available here ` +
    '(no `docker` on PATH, or the daemon is not running).\n' +
    'Options: install Docker Desktop / the docker engine and run `plum-dev build` again; ' +
    'or build the arm64 binary however you like and drop it at ' + bin + '.\n' +
    'Go services need no Docker at all — only this path does.';
}

// ------------------------------------------------------------------- build

export async function build(o: BuildOptions): Promise<BuildResult> {
  const dir = resolve(o.dir);
  const log = o.log ?? (() => {});
  const run = o.run ?? realRunner;
  const m = readManifest(dir);
  const binRel = m.server?.bin;
  if (!binRel) {
    throw new Error(`${m.id ?? 'this app'} has no server in manifest.json — there is nothing to build (a panel ships its files as they are; plum-dev package)`);
  }
  const out = normalize(join(dir, binRel));
  if (!out.startsWith(dir + '/') && out !== dir) throw new Error(`server.bin "${binRel}" points outside the app directory`);

  const detected = detectKind(dir);
  const kind = o.kind ?? detected?.kind;
  if (!kind) {
    throw new Error(
      `cannot tell how to build ${m.id ?? dir}: no go.mod, Cargo.toml, build.zig or Dockerfile.plum in ${dir} or ${join(dir, 'server')}.\n` +
      `Pass --template ${BUILD_KINDS.join('|')} (dockerfile needs --dockerfile <path> or a Dockerfile.plum).`,
    );
  }
  const source = o.kind ? sourceFor(dir, o.kind) : detected!.source;

  mkdirSync(dirname(out), { recursive: true });
  if (kind === 'go') buildGo(join(dir, source), out, log, run);
  else await buildWithDocker({ kind, context: join(dir, source), out, o, log, run });

  if (!existsSync(out)) throw new Error(`the build finished but ${out} is not there`);
  const bin = readFileSync(out);
  const problem = checkServerBinary(bin, relative(dir, out) || binRel);
  if (problem) throw new Error(problem.message);
  return { kind, out, source, bytes: bin.length };
}

function buildGo(at: string, out: string, log: (s: string) => void, run: Runner): void {
  const goMod = existsSync(join(at, 'go.mod'));
  if (!goMod) throw new Error(`${at}: no go.mod (pass --template to pick another toolchain)`);
  log(`go build → ${TARGET.goos}/${TARGET.goarch}  (no Docker needed)`);
  const r = run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', out, '.'], {
    cwd: at,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: TARGET.goos, GOARCH: TARGET.goarch },
  });
  if (r.error) throw new Error(`go is not installed or not on PATH (${r.error.message}) — install Go ≥ 1.21 from https://go.dev/dl/`);
  if (r.status !== 0) throw new Error(`go build failed (exit ${r.status}); the compiler output is above`);
}

async function buildWithDocker(a: {
  kind: BuildKind; context: string; out: string; o: BuildOptions; log: (s: string) => void; run: Runner;
}): Promise<void> {
  const haveDocker = a.o.docker ?? dockerAvailable();
  if (!haveDocker) throw new Error(dockerMissing(a.kind, a.out));

  const custom = a.o.dockerfile ?? (existsSync(join(a.context, 'Dockerfile.plum')) ? join(a.context, 'Dockerfile.plum') : undefined);
  if (a.kind === 'dockerfile' && !custom) {
    throw new Error('--template dockerfile needs --dockerfile <path> (or a Dockerfile.plum next to the sources); its final stage must hold the binary at /svc');
  }
  const tmp = mkdtempSync(join(tmpdir(), 'plum-build-'));
  try {
    const dockerfile = custom ?? join(tmp, 'Dockerfile');
    if (!custom) writeFileSync(dockerfile, dockerfileFor(a.kind));
    const dest = join(tmp, 'out');
    a.log(`docker buildx build --platform ${TARGET.platform}  (${a.kind}${custom ? `, ${isAbsolute(custom) ? custom : relative(a.context, custom)}` : ', generated Dockerfile'})`);
    const r = a.run('docker', [
      'buildx', 'build',
      '--platform', TARGET.platform,
      '-f', dockerfile,
      '--output', `type=local,dest=${dest}`,
      a.context,
    ], { cwd: a.context });
    if (r.error) throw new Error(dockerMissing(a.kind, a.out));
    if (r.status !== 0) throw new Error(`docker buildx build failed (exit ${r.status}); the build output is above`);
    const produced = join(dest, 'svc');
    if (!existsSync(produced) || !statSync(produced).isFile()) {
      throw new Error(`the image's final stage has no /svc — a build Dockerfile must end with a stage that holds the binary at /svc (see plum-dev build --help)`);
    }
    rmSync(a.out, { force: true });
    copyFileSync(produced, a.out); // not rename: tmpdir is often another filesystem
    chmodSync(a.out, 0o755);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
