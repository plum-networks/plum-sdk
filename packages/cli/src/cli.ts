#!/usr/bin/env node
// plum-dev — the `adb install` / Xcode Run of Plum Box apps.
//
//   keygen                       publisher key + recovery key (once)
//   pair <box> [--name] [--namespace] [--code]   trust this key on your own box
//   login --box <url> --token <pat>     use an existing developer token
//   init <name> [--template panel|server-go] [--id <app id>]
//   validate [dir|.plu]          the box's manifest/bundle rules, locally
//   package [dir] [-o out.plu]   deterministic, signed .plu
//   sign <in.plu> [-o out.plu]   re-sign an existing bundle with your key
//   inspect <.plu>               who signed it, what it covers, does it verify
//   push [dir|.plu] [--logs] [--watch]  sign + install on the paired box
//   logs <app-id> [-f]           service stdout/stderr (follow with -f)
//   status|restart|uninstall <app-id>
//   serve [dir] [--port 4040] [--service http://127.0.0.1:8080]
//   rotate --app-id <id> (--old <key> | --recovery <key> --old-pub <ed25519:…>) [-o rotation.json]
//   publish [dir|.plu] [--store URL] [--token plum_pub_…]   upload to Plum Store (review queue)
//   whoami
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import * as api from './api.js';
import { checkBundle, collectFiles, inspectPlu, resignPlu, signBundle, verifyPlu, type SignOptions } from './bundle.js';
import { configDir, keyPath, loadCredentials, requireCredentials, saveCredentials, storeCredentials } from './config.js';
import { scaffold, type Template } from './init.js';
import { formatPublicKey, generateKey, kid, loadKey, makeRotation, parsePublicKey, saveKey, type Rotation } from './keys.js';
import type { Manifest, Problem } from './manifest.js';
import { startServe } from './serve.js';
import { readZip, type ZipEntry } from './zip.js';

const VERSION = '0.1.0';
const BOOLEAN_FLAGS = new Set(['force', 'follow', 'f', 'logs', 'watch', 'json', 'allow-host-arch', 'insecure', 'help', 'h', 'version', 'v', 'print-recovery']);

interface Args {
  cmd: string;
  pos: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: '', pos: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 0) a.flags[t.slice(2, eq)] = t.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(t.slice(2)) || i + 1 >= argv.length || argv[i + 1]!.startsWith('-')) a.flags[t.slice(2)] = true;
      else a.flags[t.slice(2)] = argv[++i]!;
    } else if (t.startsWith('-') && t.length === 2) {
      const k = t.slice(1);
      if (BOOLEAN_FLAGS.has(k) || i + 1 >= argv.length) a.flags[k] = true;
      else a.flags[k] = argv[++i]!;
    } else if (!a.cmd) a.cmd = t;
    else a.pos.push(t);
  }
  return a;
}

function str(f: Record<string, string | true>, k: string, dflt?: string): string | undefined {
  const v = f[k];
  return typeof v === 'string' ? v : dflt;
}

class UsageError extends Error {}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans.trim()); }));
}

function printProblems(problems: Problem[]): number {
  let errors = 0;
  for (const p of problems) {
    if (p.level === 'error') errors++;
    console.log(`  ${p.level === 'error' ? '✗' : '!'} ${p.message}`);
  }
  return errors;
}

function normalizeBox(u: string): string {
  let s = u.trim();
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

function loadIgnore(dir: string): string[] {
  const p = join(dir, '.plumignore');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** dir → entries (with ignore rules) or .plu → entries. */
function loadSource(target: string): { entries: ZipEntry[]; isPlu: boolean } {
  if (!existsSync(target)) throw new Error(`${target}: not found`);
  if (statSync(target).isFile()) return { entries: readZip(readFileSync(target)), isPlu: true };
  return { entries: collectFiles(target, loadIgnore(target)), isPlu: false };
}

function signOptions(flags: Record<string, string | true>): SignOptions {
  const key = loadKey(keyPath());
  const o: SignOptions = { key };
  const recPubPath = join(configDir(), 'recovery.pub');
  if (!flags['no-recovery'] && existsSync(recPubPath)) o.recoveryPub = parsePublicKey(readFileSync(recPubPath, 'utf8'));
  const rot = str(flags, 'rotation');
  if (rot) o.rotation = JSON.parse(readFileSync(rot, 'utf8')) as Rotation;
  return o;
}

function buildSigned(target: string, flags: Record<string, string | true>): { plu: Buffer; manifest: Manifest } {
  const { entries, isPlu } = loadSource(target);
  const { manifest, problems } = checkBundle(entries, !!flags['allow-host-arch']);
  const errors = printProblems(problems);
  if (errors || !manifest) throw new Error(`${errors} error(s); fix them or run \`plum-dev validate ${target}\``);
  const opts = signOptions(flags);
  const plu = isPlu ? resignPlu(readFileSync(target), opts) : signBundle(entries, opts);
  return { plu, manifest };
}

async function cmdKeygen(a: Args) {
  const kp = keyPath();
  const recPath = kp + '.recovery';
  const recPubPath = join(configDir(), 'recovery.pub');
  if (existsSync(kp) && !a.flags.force) throw new Error(`${kp} exists; pass --force to replace it (apps signed with the old key will need a rotation record)`);
  const key = generateKey();
  const rec = generateKey();
  saveKey(kp, key);
  saveKey(recPath, rec);
  writeFileSync(recPubPath, formatPublicKey(rec.pub) + '\n', { mode: 0o644 });
  console.log(`publisher key   ${kp}`);
  console.log(`  public        ${formatPublicKey(key.pub)}`);
  console.log(`  kid           ${kid(key.pub)}`);
  console.log(`recovery key    ${recPath}`);
  console.log(`  public        ${formatPublicKey(rec.pub)}   (embedded in every bundle as META/recovery.pub)`);
  console.log(`  kid           ${kid(rec.pub)}`);
  console.log('');
  console.log('Move the recovery key somewhere offline (a password manager or printed copy) and delete it from this machine.');
  console.log('If the publisher key is ever lost, `plum-dev rotate --recovery <that file>` lets every box accept a new key without the store.');
  if (a.flags['print-recovery']) console.log('\n' + readFileSync(recPath, 'utf8'));
}

async function cmdPair(a: Args) {
  const boxArg = a.pos[0];
  if (!boxArg) throw new UsageError('pair <box-url>  e.g. plum-dev pair https://pb-1234.plumbox.me  or  plum-dev pair 192.168.0.10:8443');
  const box = normalizeBox(boxArg);
  if (a.flags.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const key = loadKey(keyPath());
  const name = str(a.flags, 'name', userInfo().username)!;
  const namespace = str(a.flags, 'namespace', `dev.${userInfo().username.toLowerCase().replace(/[^a-z0-9]/g, '')}.`)!;
  const begin = await api.pairBegin(box, formatPublicKey(key.pub), name, namespace);
  console.log(`pairing request sent to ${box} (kid ${begin.kid}, namespace ${namespace}, expires in ${Math.round(begin.expires_in / 60)} min)`);
  console.log(begin.hint);
  const code = str(a.flags, 'code') ?? (await ask('6-digit code shown on the box: '));
  const done = await api.pairConfirm(box, begin.pairing_id, code);
  if (!done.token) throw new Error('the box confirmed the key but issued no developer token; upgrade the box or use `plum-dev login --token`');
  saveCredentials({ box, token: done.token, kid: done.kid, namespace: done.namespace_prefix, paired_at: new Date().toISOString() });
  console.log(`paired: ${box} trusts ${done.kid} for apps under "${done.namespace_prefix}" (box trust level ${done.trust_level})`);
  console.log(`credentials saved to ${join(configDir(), 'credentials.json')}`);
}

async function cmdLogin(a: Args) {
  const pubTok = str(a.flags, 'publisher-token');
  if (pubTok) {
    if (!pubTok.startsWith('plum_pub_')) throw new UsageError('login --publisher-token <plum_pub_…>  (from developer.plum.im › CLI tokens)');
    const prev = loadCredentials() ?? { box: '', token: '' };
    saveCredentials({ ...prev, publisher_token: pubTok, store: (str(a.flags, 'store') || prev.store || '').replace(/\/+$/, '') || undefined });
    console.log(`publisher token saved to ${join(configDir(), 'credentials.json')}`);
    return;
  }
  const box = str(a.flags, 'box');
  const token = str(a.flags, 'token');
  if (!box || !token) throw new UsageError('login --box <url> --token <plum_pat_…>   (token needs the apps:install and apps:dev scopes)\n       login --publisher-token <plum_pub_…> [--store <url>]');
  saveCredentials({ ...(loadCredentials() ?? {}), box: normalizeBox(box), token });
  console.log(`credentials saved for ${normalizeBox(box)}`);
}

async function cmdPublish(a: Args) {
  const target = a.pos[0] ?? '.';
  const { store, token } = storeCredentials({ store: str(a.flags, 'store'), token: str(a.flags, 'token') });
  const { plu, manifest } = buildSigned(target, a.flags);
  const r = await api.publish(store, token, plu, `${manifest.id}-${manifest.version}.plu`);
  console.log(`uploaded ${r.app_id} ${r.version} to ${store}: ${r.status}${r.created_app ? ' (new app)' : ''}${r.rotated ? ', key rotation accepted' : ''}`);
  console.log(`signed by ${r.publisher_kid ?? '?'}; store countersign ${r.countersign_kind ?? 'none'} — a reviewer publishes it, you get mail either way`);
}

async function cmdInit(a: Args) {
  const name = a.pos[0];
  if (!name) throw new UsageError('init <name> [--template panel|server-go] [--id <app id>] [--dir <path>]');
  const template = (str(a.flags, 'template', 'panel') as Template);
  if (template !== 'panel' && template !== 'server-go') throw new UsageError(`unknown template "${template}" (panel | server-go)`);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ns = loadCredentials()?.namespace ?? `dev.${userInfo().username.toLowerCase().replace(/[^a-z0-9]/g, '')}.`;
  const id = str(a.flags, 'id', ns + slug)!;
  const dir = resolve(str(a.flags, 'dir', slug)!);
  const files = scaffold(dir, name, id, template);
  console.log(`created ${dir} (${id}, template ${template}):`);
  for (const f of files) console.log(`  ${f}`);
  console.log(`\nnext: cd ${basename(dir)} && plum-dev serve${template === 'server-go' ? '   (and ./build.sh before plum-dev push)' : ''}`);
}

async function cmdValidate(a: Args) {
  const target = a.pos[0] ?? '.';
  const { entries, isPlu } = loadSource(target);
  const { manifest, problems } = checkBundle(entries, !!a.flags['allow-host-arch']);
  if (manifest) console.log(`${manifest.id} ${manifest.version} (${entries.filter((e) => !e.name.startsWith('META/')).length} files${manifest.server ? ', server' : ''})`);
  const errors = printProblems(problems);
  if (isPlu) {
    const v = verifyPlu(readFileSync(target));
    console.log(v.ok ? `  ✓ signed by ${v.kid}` : `  ! ${v.reason}`);
  }
  if (errors) { console.log(`${errors} error(s)`); process.exitCode = 1; }
  else console.log(problems.length ? 'ok (with warnings)' : 'ok');
}

async function cmdPackage(a: Args) {
  const target = a.pos[0] ?? '.';
  const { plu, manifest } = buildSigned(target, a.flags);
  const out = str(a.flags, 'o') ?? str(a.flags, 'out') ?? `${manifest.id}-${manifest.version}.plu`;
  writeFileSync(out, plu);
  console.log(`${out}  ${plu.length} bytes  sha256 ${createHash('sha256').update(plu).digest('hex')}`);
}

async function cmdSign(a: Args) {
  const input = a.pos[0];
  if (!input) throw new UsageError('sign <in.plu> [-o out.plu]');
  const out = str(a.flags, 'o') ?? str(a.flags, 'out') ?? input;
  const plu = resignPlu(readFileSync(input), signOptions(a.flags));
  writeFileSync(out, plu);
  const v = verifyPlu(plu);
  console.log(`${out}  signed by ${v.ok ? v.kid : '?'}  sha256 ${createHash('sha256').update(plu).digest('hex')}`);
}

async function cmdInspect(a: Args) {
  const input = a.pos[0];
  if (!input) throw new UsageError('inspect <file.plu>');
  const buf = readFileSync(input);
  const info = inspectPlu(buf);
  const v = verifyPlu(buf);
  if (a.flags.json) { console.log(JSON.stringify({ ...info, verify: v }, null, 2)); return; }
  console.log(`publisher  ${info.publisher ?? '(unsigned)'}${info.publisher ? '  kid ' + kid(parsePublicKey(info.publisher)) : ''}`);
  if (info.recovery) console.log(`recovery   ${info.recovery}  kid ${kid(parsePublicKey(info.recovery))}`);
  console.log(`signature  ${v.ok ? 'verifies' : v.reason}`);
  console.log(`files      ${info.files.length}`);
  for (const f of info.files) console.log(`  ${f}`);
}

async function pushOnce(target: string, a: Args) {
  const c = requireCredentials();
  const { plu, manifest } = buildSigned(target, a.flags);
  const r = await api.install(c, plu, str(a.flags, 'app-id') ?? manifest.id);
  console.log(`installed ${r.app_id} ${r.version} on ${c.box}  →  ${c.box}${r.url}${r.countersign_kind ? '' : '   (developer build: signed by ' + r.publisher_kid + ', no store countersign)'}`);
  return { c, manifest };
}

function snapshot(dir: string): string {
  const h = createHash('sha256');
  for (const e of collectFiles(dir, loadIgnore(dir))) h.update(e.name).update('\0').update(e.data).update('\0');
  return h.digest('hex');
}

async function cmdPush(a: Args) {
  const target = a.pos[0] ?? '.';
  const { c, manifest } = await pushOnce(target, a);
  if (a.flags.watch) {
    if (statSync(target).isFile()) throw new Error('--watch needs a directory');
    console.log('watching for changes (Ctrl-C to stop)…');
    let last = snapshot(target);
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = snapshot(target);
      if (now === last) continue;
      last = now;
      try {
        await pushOnce(target, a);
      } catch (e) {
        console.error(`push failed: ${(e as Error).message}`);
      }
    }
  }
  if (a.flags.logs) {
    if (!manifest.server) { console.log('(no server in manifest; nothing to follow)'); return; }
    await api.followLogs(c, manifest.id, (l) => console.log(l));
  }
}

async function cmdLogs(a: Args) {
  const id = a.pos[0];
  if (!id) throw new UsageError('logs <app-id> [-f]');
  const c = requireCredentials();
  if (a.flags.f || a.flags.follow) await api.followLogs(c, id, (l) => console.log(l));
  else for (const l of await api.logs(c, id)) console.log(l);
}

async function cmdStatus(a: Args) {
  const id = a.pos[0];
  if (!id) throw new UsageError('status <app-id>');
  console.log(JSON.stringify(await api.status(requireCredentials(), id), null, 2));
}

async function cmdRestart(a: Args) {
  const id = a.pos[0];
  if (!id) throw new UsageError('restart <app-id>');
  await api.restart(requireCredentials(), id);
  console.log(`restarted ${id}`);
}

async function cmdUninstall(a: Args) {
  const id = a.pos[0];
  if (!id) throw new UsageError('uninstall <app-id>');
  await api.uninstall(requireCredentials(), id);
  console.log(`uninstalled ${id}`);
}

async function cmdServe(a: Args) {
  const dir = resolve(a.pos[0] ?? '.');
  const mp = join(dir, 'manifest.json');
  if (!existsSync(mp)) throw new Error(`${mp} not found`);
  const m = JSON.parse(readFileSync(mp, 'utf8')) as Manifest;
  const port = Number(str(a.flags, 'port', '4040'));
  const service = str(a.flags, 'service');
  const { url } = await startServe({ dir, appId: m.id, perms: m.permissions ?? [], port, service });
  console.log(`serving ${m.id} from ${dir}`);
  console.log(`  ${url}`);
  if (service) console.log(`  /apps/${m.id}/svc/* → ${service} (with dev X-Plum-* identity headers)`);
  else if (m.server) console.log(`  manifest has a server; pass --service http://127.0.0.1:<port> to proxy plum.service calls to it`);
  console.log('  mock SDK is served as /apps/runtime/plum-sdk.js (Ctrl-C to stop)');
  await new Promise(() => {});
}

async function cmdRotate(a: Args) {
  const appId = str(a.flags, 'app-id');
  if (!appId) throw new UsageError('rotate --app-id <id> (--old <old.key> | --recovery <recovery.key> --old-pub <ed25519:…>) [--new <key>] [-o rotation.json]');
  const newKey = loadKey(str(a.flags, 'new') ?? keyPath());
  let rot;
  if (str(a.flags, 'old')) {
    const oldKey = loadKey(str(a.flags, 'old')!);
    rot = makeRotation(appId, oldKey.pub, newKey, oldKey, 'old');
  } else if (str(a.flags, 'recovery')) {
    const oldPub = str(a.flags, 'old-pub');
    if (!oldPub) throw new UsageError('--recovery also needs --old-pub <the lost key\'s public key, from any previous bundle: plum-dev inspect old.plu>');
    rot = makeRotation(appId, parsePublicKey(oldPub), newKey, loadKey(str(a.flags, 'recovery')!), 'recovery');
  } else throw new UsageError('rotate needs --old <key> or --recovery <key>');
  const out = str(a.flags, 'o') ?? str(a.flags, 'out') ?? 'rotation.json';
  writeFileSync(out, JSON.stringify(rot, null, 2) + '\n');
  console.log(`${out}: ${appId} ${kid(parsePublicKey(rot.old_pub))} → ${kid(newKey.pub)} (signed by ${rot.signer} key)`);
  console.log(`include it in the next release: plum-dev package --rotation ${out}`);
}

async function cmdWhoami() {
  const c = loadCredentials();
  console.log(`config     ${configDir()}`);
  if (existsSync(keyPath())) {
    const k = loadKey(keyPath());
    console.log(`publisher  ${formatPublicKey(k.pub)}  kid ${kid(k.pub)}`);
  } else console.log('publisher  (no key; run plum-dev keygen)');
  if (c) console.log(`box        ${c.box}${c.namespace ? '  namespace ' + c.namespace : ''}${c.paired_at ? '  paired ' + c.paired_at : ''}`);
  else console.log('box        (not paired; run plum-dev pair <box-url>)');
  if (c?.publisher_token) console.log(`store      ${c.store || 'https://store.plum.im'}  token ${c.publisher_token.slice(0, 17)}…`);
  else console.log('store      (no publisher token; plum-dev login --publisher-token <plum_pub_…>)');
}

const HELP = `plum-dev ${VERSION} — build, sign and install Plum Box apps on your own box

  keygen [--force]                       create publisher + recovery keys
  pair <box-url> [--name N] [--namespace dev.me.] [--code 123456] [--insecure]
  login --box <url> --token <plum_pat_…>
  init <name> [--template panel|server-go] [--id <app id>]
  validate [dir|.plu] [--allow-host-arch]
  package [dir] [-o out.plu] [--rotation rotation.json] [--no-recovery]
  sign <in.plu> [-o out.plu]
  inspect <.plu> [--json]
  push [dir|.plu] [--app-id <id>] [--logs] [--watch]
  logs <app-id> [-f]
  status | restart | uninstall <app-id>
  serve [dir] [--port 4040] [--service http://127.0.0.1:8080]
  rotate --app-id <id> (--old <key> | --recovery <key> --old-pub <pub>) [-o rotation.json]
  publish [dir|.plu] [--store <url>] [--token <plum_pub_…>]   (or: login --publisher-token …)
  whoami

env: PLUM_DEV_HOME (config dir, default ~/.config/plum-dev), PLUM_DEV_KEY (publisher key path)`;

export async function main(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  if (a.flags.version || a.flags.v) { console.log(VERSION); return; }
  if (!a.cmd || a.flags.help || a.flags.h || a.cmd === 'help') { console.log(HELP); return; }
  const commands: Record<string, (a: Args) => Promise<void>> = {
    keygen: cmdKeygen, pair: cmdPair, login: cmdLogin, init: cmdInit, validate: cmdValidate, package: cmdPackage, sign: cmdSign,
    inspect: cmdInspect, push: cmdPush, logs: cmdLogs, status: cmdStatus, restart: cmdRestart, uninstall: cmdUninstall,
    serve: cmdServe, rotate: cmdRotate, whoami: cmdWhoami, publish: cmdPublish,
  };
  const fn = commands[a.cmd];
  if (!fn) throw new UsageError(`unknown command "${a.cmd}"\n\n${HELP}`);
  await fn(a);
}

const isEntry = process.argv[1] && /(^|\/)(cli\.js|plum-dev)$/.test(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    if (e instanceof api.BoxError) console.error(`plum-dev: box said ${e.status} ${e.code}: ${e.message}`);
    else if (e instanceof UsageError) console.error(`usage: plum-dev ${e.message}`);
    else console.error(`plum-dev: ${(e as Error).message}`);
    process.exit(1);
  });
}
