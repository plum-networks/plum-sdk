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
  clients?: ClientSpec[];
  protocols?: ProtocolSpec[];
}

/** One registered OAuth client of the app (a companion app). */
export interface ClientSpec {
  client_id: string;
  display_name: string;
  platform: string;
  redirect_uris: string[];
  scopes_allowed: string[];
}

/** One standard-protocol mount the app's service answers (core proxies it verbatim). */
export interface ProtocolSpec {
  type: string;
  mount: string;
}

export const PROTOCOL_TYPES = ['webdav', 'caldav', 'carddav'] as const;
export const MAX_PROTOCOLS = 4;
/** The optional one-segment suffix of a mount, mirroring core's protocolSegmentRe. */
export const PROTOCOL_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Ids core serves itself; an app may not take them (apps.ReservedAppIDs). */
export const RESERVED_APP_IDS = ['files', 'runtime'] as const;

export const CLIENT_PLATFORMS = ['ios', 'android', 'macos', 'windows', 'linux', 'web', 'cli'] as const;
export const CLIENT_LABEL_RE = /^[a-z0-9-]{1,32}$/;
export const MAX_CLIENTS = 10;
export const MAX_CLIENT_REDIRECTS = 8;
/** Scopes a client may be registered for; read/write are aliases of files:read / files:read+files:write. */
export const OAUTH_SCOPES = ['files:read', 'files:write', 'user:profile', 'read', 'write'] as const;

/** RFC 8252 native redirect target: custom scheme with a host/opaque part, or http loopback (any port). */
export function isNativeRedirect(uri: string): boolean {
  if (!uri || uri.length > 512) return false;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'http') return ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname.toLowerCase());
  if (['https', 'ftp', 'ws', 'wss', ''].includes(scheme)) return false;
  // A custom scheme must deep-link somewhere: "myapp://cb" or "com.example.app:/oauth".
  return uri.length > scheme.length + 1;
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
  if (m.id && (RESERVED_APP_IDS as readonly string[]).includes(m.id)) err(`id "${m.id}" is reserved by the box (it already serves that path)`);
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
  if (m.clients !== undefined) {
    if (!Array.isArray(m.clients)) err('clients must be an array');
    else {
      if (m.clients.length > MAX_CLIENTS) err(`clients: at most ${MAX_CLIENTS} entries`);
      const seen = new Set<string>();
      m.clients.forEach((c, i) => {
        const at = `clients[${i}]`;
        if (typeof c !== 'object' || c === null) { err(`${at} must be an object`); return; }
        const prefix = `${m.id}:`;
        if (typeof c.client_id !== 'string' || !c.client_id.startsWith(prefix) || !CLIENT_LABEL_RE.test(c.client_id.slice(prefix.length))) {
          err(`${at}.client_id must be "${prefix}<label>" with label [a-z0-9-]{1,32}`);
        } else if (seen.has(c.client_id)) err(`${at}.client_id "${c.client_id}" repeated`);
        else seen.add(c.client_id);
        if (typeof c.display_name !== 'string' || !c.display_name.trim() || c.display_name.length > 80) err(`${at}.display_name: 1..80 characters`);
        if (!(CLIENT_PLATFORMS as readonly string[]).includes(c.platform)) err(`${at}.platform must be one of ${CLIENT_PLATFORMS.join(', ')}`);
        if (!Array.isArray(c.redirect_uris) || c.redirect_uris.length === 0 || c.redirect_uris.length > MAX_CLIENT_REDIRECTS) err(`${at}.redirect_uris: 1..${MAX_CLIENT_REDIRECTS} entries`);
        else for (const u of c.redirect_uris) if (!isNativeRedirect(String(u))) err(`${at}.redirect_uris: "${u}" is not a native redirect target (custom scheme or http loopback; https is never allowed)`);
        if (!Array.isArray(c.scopes_allowed) || c.scopes_allowed.length === 0 || c.scopes_allowed.length > 8) err(`${at}.scopes_allowed: 1..8 entries`);
        else for (const sc of c.scopes_allowed) {
          const s = String(sc).trim().toLowerCase();
          if ((OAUTH_SCOPES as readonly string[]).includes(s)) continue;
          if (s === `service:call:${m.id}`) continue;
          if (s.startsWith('service:call:')) err(`${at}.scopes_allowed: "${s}" names another app's service (only service:call:${m.id})`);
          else err(`${at}.scopes_allowed: unknown scope "${s}" (files:read, files:write, user:profile, service:call:${m.id})`);
        }
      });
    }
  }
  if (m.protocols !== undefined) {
    if (!Array.isArray(m.protocols)) err('protocols must be an array');
    else if (m.protocols.length > 0) {
      if (m.protocols.length > MAX_PROTOCOLS) err(`protocols: at most ${MAX_PROTOCOLS} mounts`);
      if (!m.server) err('protocols requires server');
      if (!(m.permissions ?? []).includes('service:call')) err('protocols requires the "service:call" permission');
      const base = `/dav/${m.id}/`;
      const mounted = new Set<string>();
      m.protocols.forEach((pr, i) => {
        const at = `protocols[${i}]`;
        if (typeof pr !== 'object' || pr === null) { err(`${at} must be an object`); return; }
        if (!(PROTOCOL_TYPES as readonly string[]).includes(pr.type)) err(`${at}.type must be one of ${PROTOCOL_TYPES.join(', ')}`);
        const mount = typeof pr.mount === 'string' ? pr.mount.trim() : '';
        if (mount !== base) {
          const rest = mount.startsWith(base) ? mount.slice(base.length) : null;
          if (rest === null || !rest.endsWith('/') || !PROTOCOL_SEGMENT_RE.test(rest.slice(0, -1))) {
            err(`${at}.mount "${pr.mount}" must be "${base}" or "${base}" plus one [a-z0-9._-] segment`);
          }
        }
        if (mounted.has(mount)) err(`${at}.mount "${mount}" repeated`);
        else mounted.add(mount);
      });
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
