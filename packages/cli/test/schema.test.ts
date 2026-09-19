// packages/manifest/manifest.schema.json is what the store validates uploads
// with; manifest.ts is what the CLI validates with. Keep them from drifting.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_PERMISSIONS, ID_RE, parseByteSize, validateManifest } from '../src/manifest.js';

const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', 'manifest', 'manifest.schema.json'), 'utf8')) as {
  required: string[];
  properties: Record<string, any>;
};

describe('manifest schema ↔ CLI validator', () => {
  it('agree on id pattern, permissions and limit ranges', () => {
    expect(schema.properties.id.pattern).toBe(ID_RE.source);
    expect(schema.properties.permissions.items.enum).toEqual([...ALLOWED_PERMISSIONS]);
    expect(schema.required).toEqual(['id', 'name', 'version']);
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
