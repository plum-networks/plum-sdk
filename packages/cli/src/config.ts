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
  box: string; // https://pb-xxxx.plumbox.me or http://192.168.0.10:8443
  token: string; // plum_pat_… with apps:install + apps:dev
  kid?: string;
  namespace?: string;
  paired_at?: string;
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

export function requireCredentials(): Credentials {
  const c = loadCredentials();
  if (!c || !c.box || !c.token) {
    throw new Error('not connected to a box yet — run: plum-dev pair <box-url>   (or plum-dev login --box <url> --token <plum_pat_…>)');
  }
  return c;
}
