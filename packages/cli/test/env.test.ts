// Plum's environments (S4): production is the default; --env staging takes
// only staging boxes, and production never a staging one.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTION, STAGING } from '../../client/src/env.js';
import { main } from '../src/cli.js';
import { checkBoxEnv, PLUM_ENVS, plumEnv, requireCredentials, saveCredentials } from '../src/config.js';

const PROD_BOX = 'https://pb-0123456789abcdef0123456789abcdef.plumbox.me';
const STAG_BOX = 'https://pb-0123456789abcdef0123456789abcdef.staging.plumbox.me';
const TOKEN = 'plum_pat_test_0123456789';

let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plumdev-env-'));
  process.env.PLUM_DEV_HOME = home;
  delete process.env.PLUM_DEV_ENV;
  delete process.env.PLUM_DEV_TARGET;
});
afterEach(() => {
  delete process.env.PLUM_DEV_ENV;
});

async function run(...argv: string[]): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  try {
    await main(argv);
  } finally {
    spy.mockRestore();
  }
  return out.join('\n');
}

describe('environments', () => {
  it('pins production and matches @plumbox/client', () => {
    expect({ ...PLUM_ENVS.production }).toEqual({ name: 'production', boxDomain: 'plumbox.me', portalOrigin: 'https://plumbox.me', relayUrl: 'https://relay.plumbox.me' });
    expect({ ...PLUM_ENVS.production }).toEqual({ ...PRODUCTION });
    expect({ ...PLUM_ENVS.staging }).toEqual({ ...STAGING });
  });

  it('is production unless --env or PLUM_DEV_ENV says staging', () => {
    expect(plumEnv().name).toBe('production');
    expect(plumEnv('staging').name).toBe('staging');
    process.env.PLUM_DEV_ENV = 'staging';
    expect(plumEnv().name).toBe('staging');
    expect(plumEnv('production').name).toBe('production');
    for (const bad of ['prod', 'Staging', 'dev']) expect(() => plumEnv(bad)).toThrow(/--env must be/);
  });

  it('takes only its own boxes', () => {
    expect(() => checkBoxEnv(PROD_BOX, PLUM_ENVS.production)).not.toThrow();
    expect(() => checkBoxEnv(STAG_BOX, PLUM_ENVS.production)).toThrow(/staging box.*--env staging/);
    expect(() => checkBoxEnv(STAG_BOX, PLUM_ENVS.staging)).not.toThrow();
    expect(() => checkBoxEnv(PROD_BOX, PLUM_ENVS.staging)).toThrow(/production box; this is the staging CLI/);
    for (const env of Object.values(PLUM_ENVS)) {
      for (const lan of ['http://192.168.0.10:8443', 'http://127.0.0.1:8080', 'https://evilplumbox.me']) {
        expect(() => checkBoxEnv(lan, env)).not.toThrow();
      }
    }
  });

  it('login and pair refuse another environment\'s box before anything is saved or sent', async () => {
    await expect(run('login', '--box', STAG_BOX, '--token', TOKEN)).rejects.toThrow(/staging box/);
    await expect(run('pair', STAG_BOX, '--code', '424242')).rejects.toThrow(/staging box/);
    await expect(run('login', '--box', PROD_BOX, '--token', TOKEN, '--env', 'staging')).rejects.toThrow(/production box/);
    expect(existsSync(join(home, 'credentials.json'))).toBe(false);
    await run('login', '--box', STAG_BOX, '--token', TOKEN, '--env', 'staging');
    expect(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).box).toBe(STAG_BOX);
  });

  it('the box commands refuse saved credentials of another environment', async () => {
    saveCredentials({ box: STAG_BOX, token: TOKEN });
    expect(() => requireCredentials()).toThrow(/staging box/);
    expect(requireCredentials(undefined, 'staging').box).toBe(STAG_BOX);
    await expect(run('restart', 'com.example.app')).rejects.toThrow(/staging box/);
    saveCredentials({ box: PROD_BOX, token: TOKEN, emulator: { box: 'http://127.0.0.1:8080', token: TOKEN } });
    expect(requireCredentials().box).toBe(PROD_BOX);
    expect(() => requireCredentials(undefined, 'staging')).toThrow(/production box/);
    expect(requireCredentials('emulator', 'staging').box).toBe('http://127.0.0.1:8080');
  });
});
