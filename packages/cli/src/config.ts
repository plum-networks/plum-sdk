// ~/.config/plum-dev/: credentials.json (box url + developer token, 0600),
// publisher.key and publisher.key.recovery (see keys.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(): string {
  return process.env.PLUM_DEV_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'plum-dev');
}

export function keyPath(): string {
  return process.env.PLUM_DEV_KEY || join(configDir(), 'publisher.key');
}

export interface Credentials {
  box: string; // https://pb-xxxx.plumbox.me (production) or http://192.168.0.10:8443
  token: string; // plum_pat_… with apps:install + apps:dev
  kid?: string;
  namespace?: string;
  paired_at?: string;
  // Plum Store publishing (plum-dev publish): a publisher token from the
  // developer console (developer.plum.im › CLI tokens), never the box token.
  store?: string;
  publisher_token?: string;
  // The local emulator (plum-dev emulator login): kept beside the real box so
  // `push --target emulator` never clobbers the pairing.
  emulator?: { box: string; token: string; logged_in_at?: string };
}

export function loadCredentials(): Credentials | null {
  const p = join(configDir(), 'credentials.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(c: Credentials): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir(), 'credentials.json'), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

export const DEFAULT_STORE = 'https://store.plum.im';

/** Store URL + publisher token, from flags/env first, then credentials.json. */
export function storeCredentials(flags: { store?: string; token?: string }): { store: string; token: string } {
  const c = loadCredentials();
  const token = flags.token || process.env.PLUM_PUBLISHER_TOKEN || c?.publisher_token || '';
  const store = (flags.store || process.env.PLUM_STORE_URL || c?.store || DEFAULT_STORE).replace(/\/+$/, '');
  if (!token) {
    throw new Error(
      'no publisher token — create one at developer.plum.im › CLI tokens, then: plum-dev login --publisher-token <plum_pub_…>  (or set PLUM_PUBLISHER_TOKEN)',
    );
  }
  if (!token.startsWith('plum_pub_')) throw new Error('publisher tokens start with plum_pub_ (a box token cannot publish)');
  return { store, token };
}

/**
 * Plum's environments (S4). Production is the default; `--env staging` (or
 * PLUM_DEV_ENV=staging) is Plum's own staging. The values are the same as
 * @plumbox/client's src/env.ts (the CLI does not depend on that package; a
 * test keeps the two equal).
 */
export interface PlumEnv {
  readonly name: 'production' | 'staging';
  readonly boxDomain: string;
  readonly portalOrigin: string;
  readonly relayUrl: string;
}

export const PLUM_ENVS: Readonly<Record<PlumEnv['name'], PlumEnv>> = Object.freeze({
  production: Object.freeze({ name: 'production', boxDomain: 'plumbox.me', portalOrigin: 'https://plumbox.me', relayUrl: 'https://relay.plumbox.me' }),
  staging: Object.freeze({ name: 'staging', boxDomain: 'staging.plumbox.me', portalOrigin: 'https://staging.plumbox.me', relayUrl: 'https://relay.staging.plumbox.me' }),
});

/** The environment named by --env (or PLUM_DEV_ENV); production when neither is set. */
export function plumEnv(name?: string): PlumEnv {
  const n = name || process.env.PLUM_DEV_ENV || 'production';
  if (n !== 'production' && n !== 'staging') throw new Error(`--env must be "production" or "staging", not "${n}"`);
  return PLUM_ENVS[n];
}

/**
 * Refuse a box of another environment: a production CLI never talks to a
 * *.staging.plumbox.me box, and a staging CLI never to a production one. A
 * LAN address, localhost or the emulator belongs to neither.
 */
export function checkBoxEnv(box: string, env: PlumEnv): void {
  let host: string;
  try {
    host = new URL(box).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return;
  }
  let owner: PlumEnv | undefined;
  for (const e of Object.values(PLUM_ENVS)) {
    if ((host === e.boxDomain || host.endsWith('.' + e.boxDomain)) && (!owner || e.boxDomain.length > owner.boxDomain.length)) owner = e;
  }
  if (owner && owner.name !== env.name) {
    throw new Error(`${box} is a ${owner.name} box; this is the ${env.name} CLI${owner.name === 'staging' ? ' (pass --env staging)' : ''}`);
  }
}

export const EMULATOR_BOX = 'http://127.0.0.1:8080';

/**
 * Which box a command talks to: the paired box (default) or the emulator
 * (`--target emulator`, or PLUM_DEV_TARGET=emulator). The emulator entry is a
 * Credentials view of the same shape so api.ts does not care.
 */
export function requireCredentials(target?: string, env?: string): Credentials {
  const e = plumEnv(env);
  const c = loadCredentials();
  const t = (target || process.env.PLUM_DEV_TARGET || 'box').toLowerCase();
  if (t === 'emulator' || t === 'emu') {
    if (!c?.emulator?.box || !c.emulator.token) {
      throw new Error('no emulator session — run: plum-dev emulator up && plum-dev emulator login   (or plum-dev emulator login --token <plum_pat_…>)');
    }
    checkBoxEnv(c.emulator.box, e);
    return { ...c, box: c.emulator.box, token: c.emulator.token };
  }
  if (t !== 'box') throw new Error(`--target must be "box" or "emulator", not "${target}"`);
  if (!c || !c.box || !c.token) {
    throw new Error('not connected to a box yet — run: plum-dev pair <box-url>   (or plum-dev login --box <url> --token <plum_pat_…>; for the emulator: plum-dev emulator login)');
  }
  checkBoxEnv(c.box, e);
  return c;
}
