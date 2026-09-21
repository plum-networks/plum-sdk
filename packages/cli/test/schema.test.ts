// packages/manifest/manifest.schema.json is what the store validates uploads
// with; manifest.ts is what the CLI validates with. Keep them from drifting.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_PERMISSIONS, ID_RE, parseByteSize, validateManifest, MAX_CLIENTS, CLIENT_PLATFORMS, MAX_CLIENT_REDIRECTS, CLIENT_LABEL_RE, MAX_PROTOCOLS, PROTOCOL_TYPES, RESERVED_APP_IDS } from '../src/manifest.js';

const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', 'manifest', 'manifest.schema.json'), 'utf8')) as {
  required: string[];
  properties: Record<string, any>;
};

describe('manifest schema ↔ CLI validator', () => {
  it('agree on id pattern, permissions and limit ranges', () => {
    expect(schema.properties.id.pattern).toBe(ID_RE.source);
    expect(schema.properties.permissions.items.enum).toEqual([...ALLOWED_PERMISSIONS]);
    expect(schema.required).toEqual(['id', 'name', 'version']);
    const clients = schema.properties.clients;
    expect(clients.maxItems).toBe(MAX_CLIENTS);
    expect(clients.items.properties.platform.enum).toEqual([...CLIENT_PLATFORMS]);
    expect(clients.items.properties.redirect_uris.maxItems).toBe(MAX_CLIENT_REDIRECTS);
    expect(clients.items.properties.client_id.pattern).toBe(`${ID_RE.source.slice(0, -1)}:${CLIENT_LABEL_RE.source.slice(1)}`);
    const limits = schema.properties.server.properties.limits.properties;
    expect(limits.cpu.maximum).toBe(400);
    expect(limits.pids.maximum).toBe(1024);
    const memRe = new RegExp(limits.memory.pattern);
    for (const ok of ['256M', '1G', '512MiB', '1048576', '64k']) {
      expect(memRe.test(ok)).toBe(true);
      expect(() => parseByteSize(ok)).not.toThrow();
    }
    for (const bad of ['lots', '-1M', '1.5G']) {
      expect(memRe.test(bad)).toBe(false);
      expect(() => parseByteSize(bad)).toThrow();
    }
  });

  it('validator applies the required fields the schema lists', () => {
    for (const field of schema.required) {
      const m: Record<string, string> = { id: 'dev.a.b', name: 'n', version: '1' };
      delete m[field];
      const { problems } = validateManifest(Buffer.from(JSON.stringify(m)));
      expect(problems.some((p) => p.level === 'error' && p.message.includes(field))).toBe(true);
    }
  });
});

describe('manifest clients[]', () => {
  const base = { id: 'dev.a.notes', name: 'Notes', version: '1.0.0' };
  const good = { client_id: 'dev.a.notes:ios', display_name: 'Notes', platform: 'ios', redirect_uris: ['notes://cb', 'http://127.0.0.1/cb'], scopes_allowed: ['files:read', 'service:call:dev.a.notes'] };
  const errorsOf = (clients: unknown) =>
    validateManifest(Buffer.from(JSON.stringify({ ...base, clients }))).problems.filter((p) => p.level === 'error').map((p) => p.message);

  it('accepts a well-formed client', () => {
    expect(errorsOf([good])).toEqual([]);
  });

  it('rejects what the box and the store reject', () => {
    expect(errorsOf([{ ...good, client_id: 'dev.b.x:ios' }])[0]).toMatch(/client_id/);
    expect(errorsOf([{ ...good, client_id: 'dev.a.notes:IOS App' }])[0]).toMatch(/client_id/);
    expect(errorsOf([{ ...good, platform: 'tv' }])[0]).toMatch(/platform/);
    expect(errorsOf([{ ...good, redirect_uris: ['https://evil.example/cb'] }])[0]).toMatch(/redirect/);
    expect(errorsOf([{ ...good, redirect_uris: [] }])[0]).toMatch(/redirect_uris/);
    expect(errorsOf([{ ...good, scopes_allowed: ['admin'] }])[0]).toMatch(/unknown scope/);
    expect(errorsOf([{ ...good, scopes_allowed: ['service:call:dev.b.x'] }])[0]).toMatch(/another app/);
    expect(errorsOf([good, good])[0]).toMatch(/repeated/);
    expect(errorsOf(Array.from({ length: 11 }, (_, i) => ({ ...good, client_id: `dev.a.notes:c${i}` })))[0]).toMatch(/at most 10/);
  });
});

describe('manifest protocols[]', () => {
  // Mirrors plum-box-core internal/apps/manifest.go validateProtocols: the app
  // id is the namespace, so no app can claim another's mount or the box's own
  // /dav/files/, and a mount with no service behind it is refused outright.
  const base = {
    id: 'dev.a.cal',
    name: 'Cal',
    version: '1.0.0',
    permissions: ['service:call'],
    server: { bin: 'svc' },
  };
  const errorsOf = (protocols: unknown, extra: Record<string, unknown> = {}) =>
    validateManifest(Buffer.from(JSON.stringify({ ...base, ...extra, protocols })))
      .problems.filter((p) => p.level === 'error')
      .map((p) => p.message);

  it('accepts the app root and one sub-segment', () => {
    expect(errorsOf([{ type: 'caldav', mount: '/dav/dev.a.cal/' }])).toEqual([]);
    expect(
      errorsOf([
        { type: 'caldav', mount: '/dav/dev.a.cal/calendar/' },
        { type: 'carddav', mount: '/dav/dev.a.cal/contacts/' },
      ]),
    ).toEqual([]);
  });

  it('refuses another app id, the box mount, a missing slash and two segments', () => {
    expect(errorsOf([{ type: 'caldav', mount: '/dav/dev.b.other/' }])[0]).toMatch(/mount/);
    expect(errorsOf([{ type: 'webdav', mount: '/dav/files/' }])[0]).toMatch(/mount/);
    expect(errorsOf([{ type: 'caldav', mount: '/dav/dev.a.cal' }])[0]).toMatch(/mount/);
    expect(errorsOf([{ type: 'caldav', mount: '/dav/dev.a.cal/a/b/' }])[0]).toMatch(/mount/);
  });

  it('refuses a bad type, repeats and more than the cap', () => {
    expect(errorsOf([{ type: 'imap', mount: '/dav/dev.a.cal/' }])[0]).toMatch(/type/);
    const dup = { type: 'caldav', mount: '/dav/dev.a.cal/' };
    expect(errorsOf([dup, dup]).some((m) => /repeated/.test(m))).toBe(true);
    const many = ['a', 'b', 'c', 'd', 'e'].map((s) => ({ type: 'webdav', mount: `/dav/dev.a.cal/${s}/` }));
    expect(errorsOf(many).some((m) => new RegExp(`at most ${MAX_PROTOCOLS}`).test(m))).toBe(true);
  });

  it('requires a server and the service:call permission', () => {
    const ok = [{ type: 'caldav', mount: '/dav/dev.a.cal/' }];
    expect(errorsOf(ok, { server: undefined }).some((m) => /requires server/.test(m))).toBe(true);
    expect(errorsOf(ok, { permissions: [] }).some((m) => /service:call/.test(m))).toBe(true);
  });

  it('refuses the ids the box serves itself', () => {
    for (const id of RESERVED_APP_IDS) {
      const { problems } = validateManifest(Buffer.from(JSON.stringify({ id, name: 'X', version: '1.0.0' })));
      expect(problems.some((p) => p.level === 'error' && /reserved by the box/.test(p.message))).toBe(true);
    }
  });

  it('pins the schema to the same rules', () => {
    const s = schema.properties.protocols;
    expect(s.maxItems).toBe(MAX_PROTOCOLS);
    expect(s.items.properties.type.enum).toEqual([...PROTOCOL_TYPES]);
    const re = new RegExp(s.items.properties.mount.pattern);
    expect(re.test('/dav/dev.a.cal/calendar/')).toBe(true);
    expect(re.test('/dav/dev.a.cal/a/b/')).toBe(false);
  });
});
