// manifest.json validation, mirroring the box (plum-box-core
// internal/apps/manifest.go) so a bundle that passes here installs there.

export interface ServerLimits {
  memory?: string;
  cpu?: number;
  pids?: number;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  entry?: string;
  icon?: string;
  mimeTypes?: string[];
  permissions?: string[];
  description?: string;
  mobile?: boolean;
  server?: { bin: string; args?: string[]; healthPath?: string; limits?: ServerLimits };
}

export const ALLOWED_PERMISSIONS = ['files:read', 'files:write', 'user:profile', 'service:call'] as const;
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const MAX_MANIFEST_BYTES = 32 * 1024;
export const MAX_PLU_BYTES = 50 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 2000;
export const RESERVED_PREFIXES = ['im.plum', 'plum'];

export interface Problem {
  level: 'error' | 'warning';
  message: string;
}

export function parseByteSize(s: string): number {
  let t = s.trim().toUpperCase();
  t = t.replace(/I?B$/, '');
  let mult = 1;
  if (t.endsWith('K')) { mult = 1 << 10; t = t.slice(0, -1); }
  else if (t.endsWith('M')) { mult = 1 << 20; t = t.slice(0, -1); }
  else if (t.endsWith('G')) { mult = 1 << 30; t = t.slice(0, -1); }
  const n = Number(t.trim());
  if (!Number.isInteger(n) || n <= 0) throw new Error(`size "${s}": expected e.g. 256M or 1G`);
  return n * mult;
}

function safeRelative(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\0')) return false;
  const parts = p.split('/');
  return parts.every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Validates a manifest against the box's rules. `exists` says whether a
 * bundle-relative path is in the bundle (pass undefined to skip).
 */
export function validateManifest(raw: Buffer, exists?: (rel: string) => boolean): { manifest: Manifest | null; problems: Problem[] } {
  const problems: Problem[] = [];
  const err = (message: string) => problems.push({ level: 'error', message });
  const warn = (message: string) => problems.push({ level: 'warning', message });
  if (raw.length === 0) { err('manifest.json is empty'); return { manifest: null, problems }; }
  if (raw.length > MAX_MANIFEST_BYTES) err(`manifest.json is ${raw.length} bytes; max ${MAX_MANIFEST_BYTES}`);
  let m: Manifest;
  try {
    m = JSON.parse(raw.toString('utf8')) as Manifest;
  } catch (e) {
    err(`manifest.json does not parse: ${(e as Error).message}`);
    return { manifest: null, problems };
  }
  if (typeof m !== 'object' || m === null) { err('manifest.json must be an object'); return { manifest: null, problems }; }
  if (!m.id) err('id is required');
  else if (!ID_RE.test(m.id)) err(`id "${m.id}" must match ${ID_RE}`);
  else if (RESERVED_PREFIXES.some((r) => m.id === r || m.id.startsWith(r + '.'))) warn(`id "${m.id}" is in a namespace reserved for Plum; the store will refuse it`);
  if (!m.name) err('name is required');
  if (!m.version) err('version is required');
  const entry = m.entry || 'index.html';
  if (!safeRelative(entry)) err(`entry "${entry}" is not a safe relative path`);
  else if (exists && !exists(entry)) err(`entry "${entry}" is not in the bundle`);
  if (m.icon) {
    if (!safeRelative(m.icon)) err(`icon "${m.icon}" is not a safe relative path`);
    else if (exists && !exists(m.icon)) err(`icon "${m.icon}" is not in the bundle`);
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) err('permissions must be an array');
    else for (const p of m.permissions) if (!(ALLOWED_PERMISSIONS as readonly string[]).includes(p)) err(`unknown permission "${p}" (allowed: ${ALLOWED_PERMISSIONS.join(', ')})`);
  }
  if (m.server !== undefined) {
    if (typeof m.server !== 'object' || m.server === null) err('server must be an object');
    else {
      if (!m.server.bin) err('server.bin is required when server is set');
      else if (!safeRelative(m.server.bin)) err(`server.bin "${m.server.bin}" is not a safe relative path`);
      else if (exists && !exists(m.server.bin)) err(`server.bin "${m.server.bin}" is not in the bundle`);
      if (!(m.permissions ?? []).includes('service:call')) warn('server is set but permissions lacks service:call; the web UI will not be able to reach it');
      const l = m.server.limits;
      if (l) {
        if (l.memory !== undefined) { try { parseByteSize(l.memory); } catch (e) { err(`server.limits.memory: ${(e as Error).message}`); } }
        if (l.cpu !== undefined && (l.cpu < 0 || l.cpu > 400)) err(`server.limits.cpu ${l.cpu} out of range (0..400)`);
        if (l.pids !== undefined && (l.pids < 0 || l.pids > 1024)) err(`server.limits.pids ${l.pids} out of range (0..1024)`);
      }
    }
  }
  return { manifest: m, problems };
}

/** Checks that a server binary is a 64-bit little-endian ELF for arm64. */
export function checkElf(bin: Buffer, allowHost = false): Problem | null {
  if (bin.length < 64 || bin[0] !== 0x7f || bin[1] !== 0x45 || bin[2] !== 0x4c || bin[3] !== 0x46) {
    return { level: 'error', message: 'server.bin is not an ELF executable' };
  }
  if (bin[4] !== 2) return { level: 'error', message: 'server.bin must be a 64-bit ELF' };
  const machine = bin.readUInt16LE(18);
  if (machine !== 0xb7) {
    const msg = `server.bin is built for ELF machine 0x${machine.toString(16)}; the box runs arm64 (GOOS=linux GOARCH=arm64)`;
    return allowHost ? { level: 'warning', message: msg + ' — only the emulator can run it' } : { level: 'error', message: msg };
  }
  return null;
}
