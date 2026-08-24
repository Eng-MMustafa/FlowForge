// run-tests.mjs - Self-contained test suite for the FlowForge dashboard.
// Spawns the server on a scratch project + spare port, exercises every API
// endpoint, validates the UI (syntax + i18n coverage), and checks the live
// file-watcher feed and the gate protocol end to end.
//
// Usage: node run-tests.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(__dirname, '..');
const WORKBENCH = path.resolve(DASHBOARD, '..');
// `docs/` (screenshots + landing page) is deliberately left out of the npm
// tarball, so the checks that read it only apply to a git checkout. Running
// this suite from an installed copy must not report failures about files that
// were never meant to ship.
const HAS_DOCS = fs.existsSync(path.join(WORKBENCH, 'docs', 'index.html'));
const PORT = 4890;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' - ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (r) => r.json();
const get = (p) => fetch(BASE + p).then(j);
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(j);
const del = (p) => fetch(BASE + p, { method: 'DELETE' }).then(j);

// ---------- 1. static checks (no server needed) ----------
console.log('# static checks');

// Portability: nothing that ships in git may name one machine's folder, or a
// clone on another computer silently runs against a path that does not exist.
{
  const offenders = [];
  const scan = (dir, exts) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p, exts);
      else if (exts.some((x) => e.name.endsWith(x))) {
        const hits = fs.readFileSync(p, 'utf8').match(/[A-Za-z]:\\+(Users|New folder)[^\s`"')]*/g);
        if (hits) offenders.push(`${path.relative(WORKBENCH, p)}: ${hits[0]}`);
      }
    }
  };
  scan(path.join(WORKBENCH, 'skills'), ['.md']);
  scan(path.join(WORKBENCH, 'agents'), ['.md']);
  scan(path.join(WORKBENCH, 'flows'), ['.json']);
  ok('portability: shared files carry no machine-specific path', offenders.length === 0, offenders.join(' | '));
}

// One-command launcher: `node start.mjs --check` must report install state as
// JSON without installing, starting a server or opening a browser.
{
  const r = spawnSync(process.execPath, [path.join(WORKBENCH, 'start.mjs'), '--check'], { encoding: 'utf8' });
  let rep = null;
  try { rep = JSON.parse(r.stdout); } catch {}
  ok('start.mjs: --check reports install state',
    r.status === 0 && rep && path.resolve(rep.repo).toLowerCase() === WORKBENCH.toLowerCase()
    && typeof rep.ready === 'boolean' && typeof rep.skills === 'boolean',
    (r.stdout || '').slice(0, 120) + (r.stderr || '').slice(0, 120));
}

// A fresh machine: no Devin, a busy default port, a read-only install. None of
// these may stop the dashboard from coming up.
{
  const P = await import('../../scripts/lib/platform.mjs');

  // An explicit override must win even before the directory exists, or a typo
  // silently resolves to a different machine location.
  const ghost = path.join(os.tmpdir(), 'ff-ghost-devin-' + Date.now());
  ok('fresh: DEVIN_CONFIG_DIR wins even when it does not exist yet',
    P.agentConfigDir({ env: { ...process.env, DEVIN_CONFIG_DIR: ghost } }) === ghost);

  // The launcher must hand the port to the server, not just poll it.
  const launcher = fs.readFileSync(path.join(WORKBENCH, 'start.mjs'), 'utf8');
  ok('fresh: the launcher passes the port to the server',
    /serverArgs = \[[\s\S]*?String\(PORT\)/.test(launcher));
  ok('fresh: a missing Devin does not stop the dashboard',
    /starting the dashboard anyway/.test(launcher)
    && !/Devin config directory not found[\s\S]{0,200}process\.exit\(1\)/.test(launcher));

  // Really start it with no Devin and a non-default port, then talk to it.
  const port = 4893;
  const proc = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const p = spawn(process.execPath, [${JSON.stringify(path.join(WORKBENCH, 'start.mjs'))},
      '--port=${port}', '--no-open'], { stdio: 'ignore',
      env: { ...process.env, DEVIN_CONFIG_DIR: ${JSON.stringify(ghost)}, FF_REGISTRY: ${JSON.stringify(path.join(os.tmpdir(), 'ff-fresh-registry.json'))} } });
    const stop = () => { try { process.kill(p.pid); } catch {} };
    setTimeout(async () => {
      let ok = false;
      try { ok = (await fetch('http://127.0.0.1:${port}/api/health')).ok; } catch {}
      stop();
      console.log(ok ? 'ALIVE' : 'DEAD');
      process.exit(0);
    }, 4000);
  `], { encoding: 'utf8', timeout: 25000 });
  ok('fresh: the dashboard starts with no Devin, on the port asked for',
    /ALIVE/.test(proc.stdout || ''), (proc.stdout || proc.stderr || '').slice(0, 200));

  // A port already taken must be one clear message and exit 3, not a restart
  // storm - so hold the port here and let the server run into it.
  const net = await import('node:net');
  const blocker = net.createServer(() => {});
  const takenPort = 4894;
  await new Promise((r) => blocker.listen(takenPort, '127.0.0.1', r));
  const busy = spawnSync(process.execPath, [path.join(DASHBOARD, 'server.mjs'), '', String(takenPort)], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, FF_REGISTRY: path.join(os.tmpdir(), 'ff-busy-registry.json') },
  });
  blocker.close();
  ok('fresh: a busy port exits 3 with an explanation, never a crash loop',
    busy.status === 3 && /already in use/i.test(busy.stderr || ''),
    `exit ${busy.status}: ${(busy.stderr || '').slice(0, 90)}`);

  // A mistyped project path must be one clear line, not a restart storm.
  const bad = spawnSync(process.execPath, [path.join(WORKBENCH, 'start.mjs'),
    path.join(os.tmpdir(), 'ff-no-such-project'), '--port=4895', '--no-open'],
  { encoding: 'utf8', timeout: 20000, env: { ...process.env, DEVIN_CONFIG_DIR: ghost } });
  ok('fresh: a mistyped project folder fails once, with a readable reason',
    bad.status === 1 && /project folder not found/i.test(bad.stderr || ''),
    `exit ${bad.status}`);

  // Paths with spaces (and non-Latin characters) are normal on real machines.
  const spaced = path.join(os.tmpdir(), 'ff space مشروع ' + Date.now());
  fs.mkdirSync(spaced, { recursive: true });
  const spacedRun = spawnSync(process.execPath, [path.join(DASHBOARD, 'server.mjs'), spaced, '4896'], {
    encoding: 'utf8',
    timeout: 6000,
    env: { ...process.env, FF_REGISTRY: path.join(os.tmpdir(), 'ff-spaced-registry.json') },
  });
  // It is killed by the timeout, which means it accepted the folder and served.
  ok('fresh: a project path with spaces and non-Latin characters is accepted',
    !/not found/i.test(spacedRun.stderr || '') && /url:\s+http/.test(spacedRun.stdout || ''),
    (spacedRun.stderr || '').slice(0, 90));
  fs.rmSync(spaced, { recursive: true, force: true });

  // A root-owned install must not make the tool unusable: state moves to the
  // user's own directory instead of failing to write next to the code.
  ok('fresh: state falls back to a user directory when the install is read-only',
    P.stateDir('/some/root/owned', { writable: () => false }) === P.userStateDir()
    && P.stateDir(os.tmpdir()) === os.tmpdir());
}

// Packaging: `npm publish` must ship a runnable tool and NOTHING of this
// machine. npm honours the `files` whitelist over .npmignore for whole
// directories, so the whitelist itself is expanded here and audited.
{
  const pkg = JSON.parse(fs.readFileSync(path.join(WORKBENCH, 'package.json'), 'utf8'));
  const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .filter((k) => pkg[k] && Object.keys(pkg[k]).length);
  ok('package: declares zero dependencies', deps.length === 0, deps.join(', '));

  const binPaths = Object.values(pkg.bin || {});
  ok('package: every bin entry exists and is executable JS',
    binPaths.length > 0 && binPaths.every((b) => fs.existsSync(path.join(WORKBENCH, b))),
    binPaths.join(', '));
  const binSrc = fs.readFileSync(path.join(WORKBENCH, binPaths[0]), 'utf8');
  ok('package: the bin starts with a shebang', binSrc.startsWith('#!/usr/bin/env node'));

  // Expand the whitelist the way npm does: a trailing slash means the whole
  // tree, a `*` means the matching files in that folder, anything else is a file.
  const packed = [];
  const walk = (rel) => {
    const abs = path.join(WORKBENCH, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else packed.push(child);
    }
  };
  for (const entry of pkg.files || []) {
    if (entry.endsWith('/')) walk(entry.slice(0, -1));
    else if (entry.includes('*')) {
      const dir = path.dirname(entry);
      const rx = new RegExp('^' + path.basename(entry).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const abs = path.join(WORKBENCH, dir);
      if (fs.existsSync(abs)) {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          if (!e.isDirectory() && rx.test(e.name)) packed.push(`${dir}/${e.name}`);
        }
      }
    } else packed.push(entry);
  }
  const secret = packed.filter((p) => /\.local\.|\.log$|(^|\/)AGENTS\.md$|\.workbench/.test(p));
  ok('package: the tarball carries no local machine state', secret.length === 0, secret.join(', '));
  const needed = ['start.mjs', 'install.mjs', 'dashboard/server.mjs', 'dashboard/providers.mjs',
    'dashboard/ui/index.html', 'dashboard/ui/studio.html', 'agents/coder.md', 'flows/task.json',
    'skills/flow/SKILL.md', 'scripts/lib/pdf.mjs'];
  const absent = needed.filter((n) => !packed.includes(n));
  ok('package: the tarball is actually runnable (all runtime files present)',
    absent.length === 0, absent.join(', '));

  // The README travels to npmjs.com without docs/, so every image it shows
  // must be an absolute URL - and must still exist in this repo.
  const readme = fs.readFileSync(path.join(WORKBENCH, 'README.md'), 'utf8');
  const imgs = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const relative = imgs.filter((u) => !/^https?:\/\//.test(u));
  ok('package: every README image is an absolute URL (docs/ is not packed)',
    imgs.length > 0 && relative.length === 0, relative.join(', '));
  if (HAS_DOCS) {
    const own = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//;
    const localMisses = imgs.filter((u) => own.test(u))
      .map((u) => u.replace(own, ''))
      .filter((rel) => !fs.existsSync(path.join(WORKBENCH, rel)));
    ok('package: every screenshot the README links to exists in the repo',
      localMisses.length === 0, localMisses.join(', '));
  }
}

// Cross-platform layer: every OS difference is a pure function taking the
// platform, so all three can be checked from whichever machine runs the suite.
{
  const P = await import('../../scripts/lib/platform.mjs');
  const homes = { win32: 'C:\\Users\\x', darwin: '/Users/x', linux: '/home/x' };
  const envs = {
    win32: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
    darwin: {},
    linux: {},
  };

  const cfg = {};
  for (const p of P.PLATFORMS) cfg[p] = P.agentConfigCandidates(p, envs[p], homes[p]);
  ok('platform: every OS resolves a Devin config directory',
    P.PLATFORMS.every((p) => cfg[p].length > 0 && cfg[p].every((c) => c.includes('devin'))));
  ok('platform: macOS looks in Application Support, Linux in ~/.config',
    cfg.darwin[0].includes('Application Support') && cfg.linux[0].includes('.config'));
  ok('platform: DEVIN_CONFIG_DIR overrides the guess on every OS',
    P.PLATFORMS.every((p) => P.agentConfigCandidates(p, { ...envs[p], DEVIN_CONFIG_DIR: '/tmp/dv' }, homes[p])[0] === '/tmp/dv'));

  ok('platform: junction on Windows, plain symlink elsewhere',
    P.linkType('win32') === 'junction' && P.linkType('darwin') === 'dir' && P.linkType('linux') === 'dir');
  ok('platform: path comparison follows the filesystem, not the code',
    P.caseInsensitivePaths('win32') && P.caseInsensitivePaths('darwin') && !P.caseInsensitivePaths('linux'));

  const roots = {};
  for (const p of P.PLATFORMS) roots[p] = P.providerRoots(p, envs[p], homes[p]);
  ok('platform: provider roots are non-empty on every OS',
    P.PLATFORMS.every((p) => ['local', 'appdata', 'home', 'files'].every((k) => !!roots[p][k])));
  // The whole point of the roots table: one descriptor rel, three real paths.
  const cursorSettings = (p) => path.posix.join(String(roots[p].appdata).replace(/\\/g, '/'), 'Cursor', 'User');
  ok('platform: the same descriptor finds Cursor on all three OSes',
    cursorSettings('win32').includes('AppData/Roaming/Cursor')
    && cursorSettings('darwin').includes('Application Support/Cursor')
    && cursorSettings('linux').includes('.config/Cursor'));

  ok('platform: the browser opener is right per OS',
    P.openUrlCommand('http://x', 'win32').cmd === 'cmd'
    && P.openUrlCommand('http://x', 'darwin').cmd === 'open'
    && P.openUrlCommand('http://x', 'linux').cmd === 'xdg-open');
  ok('platform: a macOS .app is opened with `open -a`',
    P.openAppCommand('/Applications/Cursor.app', 'darwin').args[0] === '-a');
  ok('platform: a Windows non-executable is never "opened"',
    P.openAppCommand('C:/x/readme.txt', 'win32') === null);

  ok('platform: taskkill only on Windows, process group elsewhere',
    P.killTreeCommand(123, 'win32').cmd === 'taskkill'
    && P.killTreeCommand(123, 'darwin') === null && P.killTreeCommand(123, 'linux') === null);

  ok('platform: login script is .cmd on Windows, executable sh elsewhere',
    P.loginScriptFormat('win32').ext === '.cmd' && P.loginScriptFormat('linux').mode === 0o755
    && P.loginScriptFormat('darwin').newline === '\n');
  const win = P.loginScriptLines({ title: 'T', note: 'hi', cliPath: 'C:/gh.exe', steps: [['auth', 'login'], ['auth', 'status']], plat: 'win32' });
  const nix = P.loginScriptLines({ title: 'T', note: 'hi', cliPath: '/usr/bin/gh', steps: [['auth', 'login'], ['auth', 'status']], plat: 'linux' });
  ok('platform: each login script speaks its own shell',
    win[0] === '@echo off' && win.includes('pause')
    && nix[0] === '#!/bin/sh' && nix.some((l) => l.includes('read _')));
  ok('platform: the login script runs login then status, both quoted',
    win.some((l) => l.includes('"auth" "login"')) && nix.some((l) => l.includes('"auth" "status"')));

  // Linux: the first terminal that exists wins, and none means none - the
  // server must not claim it opened a window that does not exist.
  const fakeHave = (want) => (cmd) => cmd === want;
  ok('platform: Linux picks an installed terminal',
    P.terminalCommand({ file: '/tmp/a.sh', plat: 'linux', have: fakeHave('konsole') }).cmd === 'konsole');
  ok('platform: Linux with no terminal returns null instead of pretending',
    P.terminalCommand({ file: '/tmp/a.sh', plat: 'linux', have: () => false }) === null);

  ok('platform: npm is a .cmd shim only on Windows',
    P.npmBin('npm', 'win32') === 'npm.cmd' && P.npmBin('npm', 'linux') === 'npm');
  ok('platform: a fresh install lands somewhere sane on every OS',
    P.PLATFORMS.every((p) => P.defaultInstallDir(p, envs[p], homes[p]).includes('FlowForge')));

  // The rule the whole layer exists for: OS branching lives HERE, not scattered.
  const scattered = [];
  for (const rel of ['dashboard/server.mjs', 'dashboard/providers.mjs', 'dashboard/acp-client.mjs',
    'install.mjs', 'uninstall.mjs', 'start.mjs', 'scripts/run-checks.mjs']) {
    const src = fs.readFileSync(path.join(WORKBENCH, rel), 'utf8');
    for (const m of src.matchAll(/process\.env\.(APPDATA|LOCALAPPDATA|USERPROFILE|ProgramFiles)/g)) {
      scattered.push(`${rel}: ${m[0]}`);
    }
  }
  ok('platform: no runtime module reads a Windows-only environment root',
    scattered.length === 0, scattered.join(', '));
}

// The landing page (GitHub Pages, served from docs/) follows the same rules as
// the dashboard: no external code, bilingual, and every image really there.
if (HAS_DOCS) {
  const site = fs.readFileSync(path.join(WORKBENCH, 'docs', 'index.html'), 'utf8');
  const scripts = [...site.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  const links = [...site.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  ok('site: loads no external script or stylesheet',
    scripts.every((a) => !/\bsrc=/.test(a)) && links.every((h) => !/^https?:/.test(h)));

  let siteSyntax = true, siteErr = '';
  const inline = site.match(/<script>([\s\S]*?)<\/script>/);
  try { new Function(inline[1]); } catch (e) { siteSyntax = false; siteErr = e.message; }
  ok('site: inline script parses (syntax valid)', siteSyntax, siteErr);

  const pairs = [...site.matchAll(/data-en="[^"]*"(?:\s|\n)*data-ar="[^"]*"/g)].length;
  const enCount = [...site.matchAll(/\bdata-en="/g)].length;
  ok('site: every English string has its Arabic twin', pairs === enCount && enCount > 10,
    `${pairs}/${enCount}`);

  const imgs = [...site.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^https?:/.test(u));
  const missing = imgs.filter((u) => !fs.existsSync(path.join(WORKBENCH, 'docs', u)));
  ok('site: every screenshot it shows exists', imgs.length > 0 && missing.length === 0,
    missing.join(', '));

  const cmd = site.match(/<code id="cmd">([^<]+)<\/code>/);
  ok('site: the copy button offers the documented install command',
    !!cmd && cmd[1].includes('get.mjs') && cmd[1].includes('Eng-MMustafa/FlowForge'));
  // A Mac visitor must not be handed a PowerShell line.
  ok('site: offers a command for Windows and one for macOS/Linux',
    /win:\s*'iwr[^']*get\.mjs[^']*'/.test(site) && /nix:\s*'curl[^']*get\.mjs[^']*'/.test(site));
}

// The one-command installer must stay dependency-free and never hard-code a
// machine path, because it is fetched and run raw from GitHub.
{
  const src = fs.readFileSync(path.join(WORKBENCH, 'get.mjs'), 'utf8');
  ok('get.mjs: zero external dependencies',
    [...src.matchAll(/from\s+'([^']+)'/g)].every((m) => m[1].startsWith('node:')));
  ok('get.mjs: carries no machine-specific path', !/[A-Za-z]:\\+Users/.test(src));
  // A bad branch must fail loudly, and only ever inside the throwaway target.
  const doomed = path.join(os.tmpdir(), 'ff-nope-' + Date.now());
  const r = spawnSync(process.execPath, [path.join(WORKBENCH, 'get.mjs'),
    doomed, '--branch=no-such-branch', '--no-start'], { encoding: 'utf8', timeout: 90000 });
  ok('get.mjs: refuses an unreachable branch instead of half-installing',
    r.status === 1 && !fs.existsSync(path.join(doomed, 'start.mjs')),
    `exit ${r.status}`);
  fs.rmSync(doomed, { recursive: true, force: true });
}

const uiSrc = fs.readFileSync(path.join(DASHBOARD, 'ui', 'index.html'), 'utf8');
const scriptMatch = uiSrc.match(/<script>([\s\S]*)<\/script>/);
ok('ui has a script block', !!scriptMatch);

// Syntax-check the UI script by parsing it (never executing it).
let syntaxOk = true, syntaxErr = '';
try { new Function(scriptMatch[1]); } catch (e) { syntaxOk = false; syntaxErr = e.message; }
ok('ui script parses (syntax valid)', syntaxOk, syntaxErr);

// i18n coverage: every referenced key exists in BOTH dictionaries.
{
  const script = scriptMatch[1];
  const dictBlock = script.match(/const I18N = \{([\s\S]*?)\n\};/)[1];
  const langs = { en: {}, ar: {} };
  for (const lang of ['en', 'ar']) {
    const m = dictBlock.match(new RegExp(`${lang}: \\{([\\s\\S]*?)\\n  \\}`));
    for (const kv of m[1].matchAll(/(\w+):\s*'/g)) langs[lang][kv[1]] = true;
  }
  const used = new Set();
  for (const m of script.matchAll(/\bt\('([\w]+)'\)/g)) used.add(m[1]);
  for (const m of uiSrc.matchAll(/data-i18n="([\w]+)"/g)) used.add(m[1]);
  // Dynamic keys built by concatenation: t('st_' + status), t('fs_' + status)
  for (const st of ['pending', 'running', 'waiting_gate', 'done', 'failed', 'skipped']) used.add('st_' + st);
  for (const st of ['running', 'waiting_gate', 'done', 'failed', 'stopped']) used.add('fs_' + st);
  // Palette labels: t('pal_' + role) and the group captions, built by concatenation.
  for (const m of script.matchAll(/\n  (\w+): \{\n\s+icon: '/g)) used.add('pal_' + m[1]);
  for (const m of script.matchAll(/cap: '(pal_group_\w+)'/g)) used.add(m[1]);
  used.delete('st_');  used.delete('fs_'); // artifacts of the regex on concatenated keys
  const missing = { en: [], ar: [] };
  for (const key of used) {
    if (!langs.en[key]) missing.en.push(key);
    if (!langs.ar[key]) missing.ar.push(key);
  }
  ok('i18n: all keys exist in EN', missing.en.length === 0, missing.en.join(','));
  ok('i18n: all keys exist in AR', missing.ar.length === 0, missing.ar.join(','));
}

// Flow files parse and carry bilingual titles.
for (const f of ['task', 'understand']) {
  const flow = JSON.parse(fs.readFileSync(path.join(WORKBENCH, 'flows', f + '.json'), 'utf8'));
  ok(`flow ${f}: valid + bilingual title`, !!(flow.title && flow.titleAr));
  ok(`flow ${f}: stages bilingual`, flow.stages.every((s) => s.title && s.titleAr));
}

// Studio (icon-only surface): parses, is provably text-free, sprite is complete.
const studioSrc = fs.readFileSync(path.join(DASHBOARD, 'ui', 'studio.html'), 'utf8');
{
  const sm = studioSrc.match(/<script>([\s\S]*)<\/script>/);
  ok('studio: has a script block', !!sm);
  let sOk = true, sErr = '';
  try { new Function(sm[1]); } catch (e) { sOk = false; sErr = e.message; }
  ok('studio: script parses (syntax valid)', sOk, sErr);

  // Text-free proof: strip code/comments/<title>, then all tags -> whitespace only.
  const visible = studioSrc
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<[^>]*>/g, '');
  ok('studio: visible markup is text-free', visible.trim() === '', JSON.stringify(visible.replace(/\s+/g, ' ').slice(0, 120)));

  // No typography smuggled in through CSS content: or emoji glyphs.
  const styleBlock = (studioSrc.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
  ok('studio: no CSS content: declarations', !/(?<![\w-])content\s*:/.test(styleBlock));
  ok('studio: no emoji glyphs', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(studioSrc));

  // Every referenced sprite id (markup <use> and script strings) is defined.
  const symbols = new Set([...studioSrc.matchAll(/<symbol id="(ic-[a-z-]+)"/g)].map((m) => m[1]));
  const refs = [...new Set([...studioSrc.matchAll(/["'#](ic-[a-z-]+)/g)].map((m) => m[1]))];
  const undef = refs.filter((r) => !symbols.has(r));
  ok('studio: sprite ids all defined', undef.length === 0, undef.join(','));

  // Preset tables carry every field buildFlow() must emit.
  const roles = ['thinker', 'analyst', 'coder', 'tester', 'debugger', 'shipper'];
  ok('studio: six role presets bilingual',
    roles.every((r) => new RegExp(r + ':\\s*\\{').test(sm[1])) && (sm[1].match(/titleAr:/g) || []).length >= 6);
  ok('studio: zero-keystroke flow name generator', sm[1].includes("'studio-' + Date.now().toString(36)"));
  ok('studio: debug loop wiring present', sm[1].includes('runOnlyWhenJumpedTo') && sm[1].includes('maxLoops'));
  ok('studio: no external resources', !/\s(?:src|href)="(?:https?:)?\/\//.test(studioSrc));
}
ok('ui: studio nav link present', uiSrc.includes('id="lnkStudio"') && uiSrc.includes('href="/studio"'));

// Review-friendly rendering pieces exist in the UI.
ok('ui: semantic badge styles present', uiSrc.includes('badge-ok') && uiSrc.includes('badge-fail') && uiSrc.includes('badge-warn'));
ok('ui: markdown table renderer present', uiSrc.includes('function mdTable'));
ok('ui: bilingual note support present', uiSrc.includes('st.noteAr'));
ok('ui: overview live feed present', uiSrc.includes('actFeedHome'));

// Visual flow editor: markup, sprite coverage, and a real graph <-> flow round trip.
let MOD_ROUNDTRIP = null; // the isolated flowToGraph/graphToFlow slice, reused below
{
  const script = scriptMatch[1];
  ok('ui: flow canvas markup present',
    uiSrc.includes('id="flowCanvas"') && uiSrc.includes('id="flowNodes"') &&
    uiSrc.includes('id="flowEdges"') && uiSrc.includes('id="flowPalette"'));
  ok('ui: canvas/json view toggle present',
    uiSrc.includes('id="btnViewCanvas"') && uiSrc.includes('id="btnViewJson"'));
  ok('ui: keyboard-free flow naming', script.includes("'flow-' + Date.now().toString(36)"));

  const symbols = new Set([...uiSrc.matchAll(/<symbol id="(ic-[a-z-]+)"/g)].map((m) => m[1]));
  const refs = [...new Set([...script.matchAll(/'(ic-[a-z-]+)'/g)].map((m) => m[1]))];
  const undef = refs.filter((r) => !symbols.has(r));
  ok('ui: editor sprite ids all defined', refs.length > 0 && undef.length === 0, undef.join(','));

  // Palette must offer script stages (agent: null) on top of the six roles.
  ok('ui: palette groups defined',
    /PALETTE_GROUPS = \[/.test(script) && ['pal_group_agents', 'pal_group_understand', 'pal_group_scripts']
      .every((k) => script.includes(k)));
  ok('ui: script (no-AI) steps available',
    /scan: \{[\s\S]*?agent: null/.test(script) && /checks: \{[\s\S]*?agent: null/.test(script));
  ok('ui: palette buttons carry a text label', script.includes("lbl.textContent = t('pal_' + role)"));
  ok('ui: nodes carry a readable name', script.includes("name.className = 'name'"));

  // Execute only the conversion section against stubs - no DOM involved.
  const seg = script.match(/\/\* ---------- flow file <-> graph ---------- \*\/([\s\S]*?)\n\/\* ---------- layout/);
  ok('ui: conversion section isolatable', !!seg);
  const make = new Function(`
    let G = { meta: null, nodes: [], edges: [] };
    const t = (k) => k;
    const gNode = (id) => G.nodes.find((n) => n.id === id) || null;
    const renderCanvas = () => {};
    const freeSpot = (i) => ({ x: 60 + (i % 6) * 190, y: 70 });
    const roleOfStage = (s) => s.agent || 'script';
    ${seg[1]}
    return { flowToGraph, graphToFlow, graph: () => G };
  `);
  const M = make();
  const taskFlow = JSON.parse(fs.readFileSync(path.join(WORKBENCH, 'flows', 'task.json'), 'utf8'));
  M.flowToGraph(taskFlow);
  const g = M.graph();
  ok('editor: every stage becomes a node', g.nodes.length === taskFlow.stages.length);
  ok('editor: failure wire read from onFail',
    g.edges.some((e) => e.kind === 'fail' && e.from === 'test' && e.to === 'debug'));
  ok('editor: jump stage wire read from next',
    g.edges.some((e) => e.kind === 'next' && e.from === 'debug' && e.to === 'test'));
  ok('editor: implicit order becomes wires',
    g.edges.some((e) => e.kind === 'next' && e.from === 'think' && e.to === 'analyze') &&
    !g.edges.some((e) => e.kind === 'next' && e.from === 'test' && e.to === 'debug'));

  const back = M.graphToFlow('task').flow;
  // Ordering rule: the wired chain first, jump-only stages appended after it.
  ok('editor: round trip orders the chain then the jump stages',
    JSON.stringify(back.stages.map((s) => s.id)) ===
    JSON.stringify(['think', 'analyze', 'code', 'test', 'ship', 'debug']));
  const backTest = back.stages.find((s) => s.id === 'test');
  const backDebug = back.stages.find((s) => s.id === 'debug');
  ok('editor: round trip keeps the debug loop',
    backTest.onFail === 'debug' && backTest.maxLoops === 3 &&
    backDebug.runOnlyWhenJumpedTo === true && backDebug.next === 'test');
  ok('editor: round trip keeps prompts and gates',
    back.stages.every((s) => {
      const orig = taskFlow.stages.find((o) => o.id === s.id);
      return s.prompt === orig.prompt && s.gate === orig.gate && s.titleAr === orig.titleAr;
    }));
  ok('editor: node positions persisted under ui.pos',
    back.ui && back.ui.pos && Number.isFinite(back.ui.pos.think.x));

  // Per-step overrides: inspector markup, round trip, and orchestrator support.
  ok('ui: step inspector present',
    ['insModel', 'insEffort', 'insGate', 'insLoops', 'insCtx', 'insChecks']
      .every((id) => uiSrc.includes(`id="${id}"`)));
  ok('ui: inspector labels are i18n keys',
    ['ins_model', 'ins_effort', 'ins_loops', 'ins_pre', 'ins_artifact']
      .every((k) => uiSrc.includes(`data-i18n="${k}"`)));
  ok('ui: model picker fed by /api/models',
    script.includes("api('/api/models?provider='") && script.includes('MODEL_FAMILIES')
    && script.includes("t('ins_level_default')"));

  M.flowToGraph({
    name: 'ov', defaultGate: 'terminal', stages: [
      { id: 'a', agent: 'coder', model: 'opus', effort: 'high', pre: ['scripts/run-checks.mjs'] },
      { id: 'b', agent: 'tester', effort: 'low' },
    ],
  });
  const ov = M.graphToFlow('ov').flow;
  ok('editor: per-step model survives the round trip', ov.stages[0].model === 'opus');
  ok('editor: per-step thinking level survives the round trip',
    ov.stages[0].effort === 'high' && ov.stages[1].effort === 'low');
  ok('editor: per-step pre-scripts survive the round trip',
    JSON.stringify(ov.stages[0].pre) === JSON.stringify(['scripts/run-checks.mjs']));

  const flowSkill = fs.readFileSync(path.join(WORKBENCH, 'skills', 'flow', 'SKILL.md'), 'utf8');
  ok('skill: honors per-stage model override', /`model`.*overrides the model pinned/.test(flowSkill));
  ok('skill: honors per-stage thinking level',
    flowSkill.includes('Thinking level: HIGH') && flowSkill.includes('Thinking level: LOW'));

  // Agents/skills must be editable through forms, not hand-written YAML.
  ok('ui: agent form fields present',
    ['agDesc', 'agModel', 'agLevel', 'agTools', 'agPrompt', 'btnNewAgent', 'btnDeleteAgent']
      .every((id) => uiSrc.includes(`id="${id}"`)));
  ok('ui: skill form fields present',
    ['skDesc', 'skBody', 'btnViewSkillForm', 'btnViewSkillRaw'].every((id) => uiSrc.includes(`id="${id}"`)));
  ok('ui: form/raw toggles are i18n keys',
    uiSrc.includes('data-i18n="view_form"') && uiSrc.includes('data-i18n="view_raw"'));

  ok('ui: folder picker present',
    ['pickerBack', 'pickerList', 'pickerUse', 'btnPickProj', 'btnPickTop', 'btnCleanProj']
      .every((id) => uiSrc.includes(`id="${id}"`)));
  ok('ui: visual builders present',
    ['agentVisualView', 'agPresets', 'agvSections', 'agvRules', 'agvPreview',
      'skillVisualView', 'skPresets', 'skvRules', 'skvPreview'].every((id) => uiSrc.includes(`id="${id}"`)));
  ok('ui: three view toggles per tab',
    uiSrc.includes('id="btnViewAgentVisual"') && uiSrc.includes('id="btnViewSkillVisual"')
    && uiSrc.includes('data-i18n="view_visual"'));

  // The click-only builder must emit a usable profile body.
  const bodySeg = script.match(/const ROLE_SECTIONS = \{[\s\S]*?\nfunction buildRoleBody\(a\) \{[\s\S]*?\n\}/);
  ok('ui: role body builder isolatable', !!bodySeg);
  const RB = new Function(`${bodySeg[0]}\n return { buildRoleBody, ROLE_RULES, ROLE_SECTIONS };`)();
  const built = RB.buildRoleBody({ name: 'auditor', desc: 'Audits things.', artifact: 'report.md',
    sections: ['inputs', 'output', 'verdict', 'summary'], rules: ['cite', 'readonly'] });
  ok('builder: generated body has every picked section',
    built.includes('## Inputs') && built.includes('report.md') && built.includes('VERDICT: PASS')
    && built.includes('5-line summary'), built.slice(0, 120));
  ok('builder: generated body has picked rules only',
    built.includes(RB.ROLE_RULES.cite) && built.includes(RB.ROLE_RULES.readonly)
    && !built.includes(RB.ROLE_RULES.measure));

  // Frontmatter round trip: parse an existing profile, recompose it, reparse.
  const fmSeg = script.match(/function parseFrontmatter\(md\) \{[\s\S]*?\nfunction composeAgent\(f\) \{[\s\S]*?\n\}/);
  ok('ui: frontmatter helpers isolatable', !!fmSeg);
  const FM = new Function(`${fmSeg[0]}\n return { parseFrontmatter, composeAgent };`)();
  const analystMd = fs.readFileSync(path.join(WORKBENCH, 'agents', 'analyst.md'), 'utf8');
  const parsed = FM.parseFrontmatter(analystMd);
  ok('form: frontmatter parsed (name, model, tools)',
    parsed.fm.name === 'analyst' && parsed.fm.model === 'sonnet'
    && parsed.list['allowed-tools'].includes('grep'), JSON.stringify(parsed.fm));
  const recomposed = FM.composeAgent({
    name: parsed.fm.name, description: parsed.fm.description, model: 'claude-opus-5-max',
    tools: parsed.list['allowed-tools'], body: parsed.body,
  });
  const again = FM.parseFrontmatter(recomposed);
  ok('form: compose -> parse keeps every field',
    again.fm.name === 'analyst' && again.fm.model === 'claude-opus-5-max'
    && again.fm.description === parsed.fm.description
    && JSON.stringify(again.list['allowed-tools']) === JSON.stringify(parsed.list['allowed-tools'])
    && again.body.trim() === parsed.body.trim());

  // Every shipped flow must be loadable by the orchestrator AND by the editor.
  const flowFiles = fs.readdirSync(path.join(WORKBENCH, 'flows')).filter((f) => f.endsWith('.json'));
  const presets = ['task', 'understand', 'quality', 'fast', 'cheap', 'bugfix', 'tests', 'design', 'analytics', 'perf'];
  ok('flows: preset library present', presets.every((p) => flowFiles.includes(p + '.json')), flowFiles.join(','));
  const flowProblems = [];
  for (const file of flowFiles) {
    const flow = JSON.parse(fs.readFileSync(path.join(WORKBENCH, 'flows', file), 'utf8'));
    const ids = flow.stages.map((s) => s.id);
    if (new Set(ids).size !== ids.length) flowProblems.push(file + ': duplicate stage id');
    if (!flow.titleAr) flowProblems.push(file + ': missing titleAr');
    for (const s of flow.stages) {
      if (!s.titleAr) flowProblems.push(file + '/' + s.id + ': missing titleAr');
      if (!s.artifact) flowProblems.push(file + '/' + s.id + ': missing artifact');
      if (s.onFail && !ids.includes(s.onFail)) flowProblems.push(file + '/' + s.id + ': onFail target missing');
      if (s.next && !ids.includes(s.next)) flowProblems.push(file + '/' + s.id + ': next target missing');
      if (s.gate && !['auto', 'terminal', 'dashboard', 'default'].includes(s.gate)) {
        flowProblems.push(file + '/' + s.id + ': bad gate');
      }
      for (const script of [...(s.pre || []), ...(s.post || [])]) {
        if (!fs.existsSync(path.join(WORKBENCH, script))) flowProblems.push(file + '/' + s.id + ': missing ' + script);
      }
    }
    // Round trip through the editor so a preset never breaks the visual view.
    M.flowToGraph(flow);
    const rt = M.graphToFlow(flow.name);
    if (rt.error) flowProblems.push(file + ': editor rejects it (' + rt.error + ')');
    else if (rt.flow.stages.length !== flow.stages.length) flowProblems.push(file + ': stage count changed');
  }
  ok('flows: all files valid and editor-safe', flowProblems.length === 0, flowProblems.join(' | '));

  // Every agent named by a flow must have a profile with a pinned model.
  const agentFiles = fs.readdirSync(path.join(WORKBENCH, 'agents')).filter((f) => f.endsWith('.md'));
  const agentNames = agentFiles.map((f) => f.replace(/\.md$/, ''));
  ok('agents: analytics + performance roles exist',
    agentNames.includes('researcher') && agentNames.includes('optimizer'), agentNames.join(','));
  ok('agents: every profile pins a model',
    agentFiles.every((f) => /^model:\s*\S+/m.test(fs.readFileSync(path.join(WORKBENCH, 'agents', f), 'utf8'))));
  const missingAgents = [];
  for (const file of flowFiles) {
    const flow = JSON.parse(fs.readFileSync(path.join(WORKBENCH, 'flows', file), 'utf8'));
    for (const s of flow.stages) {
      if (s.agent && !agentNames.includes(s.agent)) missingAgents.push(file + '/' + s.id + ': ' + s.agent);
    }
  }
  ok('flows: every named agent has a profile', missingAgents.length === 0, missingAgents.join(' | '));
  ok('flows: presets pin models on agent stages',
    ['task', 'understand', 'quality', 'analytics', 'perf'].every((name) => {
      const flow = JSON.parse(fs.readFileSync(path.join(WORKBENCH, 'flows', name + '.json'), 'utf8'));
      return flow.stages.filter((s) => s.agent).every((s) => typeof s.model === 'string' && s.model.length);
    }));

  // A graph with no entry point (pure cycle) must be rejected, not silently saved.
  M.flowToGraph({ name: 'loop', stages: [
    { id: 'a', agent: 'coder', next: 'b' },
    { id: 'b', agent: 'tester', next: 'a' },
  ] });
  ok('editor: cycle without an entry point is rejected', !!M.graphToFlow('loop').error);

  // A provider-restricted flow must survive the canvas Save path (graphToFlow),
  // otherwise the restriction is silently stripped the moment it is re-saved.
  M.flowToGraph({ name: 'pf', providers: ['cursor'], stages: [{ id: 'a', agent: 'coder' }] });
  ok('editor: flow providers survive the round trip',
    JSON.stringify(M.graphToFlow('pf').flow.providers) === JSON.stringify(['cursor']));
  M.flowToGraph({ name: 'pf2', stages: [{ id: 'a', agent: 'coder' }] });
  ok('editor: unrestricted flow gains no providers key',
    M.graphToFlow('pf2').flow.providers === undefined);
  MOD_ROUNDTRIP = M;
}

// ---------- 1b. executor-provider registry ----------
console.log('# provider registry checks');
{
  const P = await import('../providers.mjs');
  ok('providers: four ids exported',
    JSON.stringify(P.PROVIDER_IDS) === JSON.stringify(['devin', 'copilot', 'cursor', 'trae']),
    JSON.stringify(P.PROVIDER_IDS));
  ok('providers: every descriptor is bilingual with a model catalogue',
    P.PROVIDER_IDS.every((id) => P.PROVIDERS[id].label && P.PROVIDERS[id].labelAr
      && P.providerModels(id).length && P.providerModels(id).every((f) => f.slug && f.label
        && Array.isArray(f.aliases) && Array.isArray(f.variants))));
  ok('providers: only devin is runnable',
    P.PROVIDERS.devin.runnable === true
    && ['copilot', 'cursor', 'trae'].every((id) => !P.PROVIDERS[id].runnable));

  // No machine path may be hard-coded: every root comes from the environment.
  const provSrc = fs.readFileSync(path.join(DASHBOARD, 'providers.mjs'), 'utf8');
  ok('providers: registry carries no machine-specific path',
    !/[A-Za-z]:\\+(Users|New folder)/.test(provSrc));
  ok('providers: zero external dependencies',
    [...provSrc.matchAll(/from\s+'([^']+)'/g)].every((m) => m[1].startsWith('node:') || m[1].startsWith('./') || m[1].startsWith('../')));

  // Login layer: only a CLI-owned login may offer a button; an editor-owned
  // sign-in must explain itself bilingually instead of faking one.
  ok('providers: devin and copilot own their login through a CLI',
    P.providerAuthKind('devin') === 'cli' && P.providerAuthKind('copilot') === 'cli');
  ok('providers: cursor and trae declare an in-app sign-in with a bilingual reason',
    ['cursor', 'trae'].every((id) => P.providerAuthKind(id) === 'app'
      && P.PROVIDERS[id].auth.reason && P.PROVIDERS[id].auth.reasonAr));
  ok('providers: in-app sign-in yields no login script',
    ['cursor', 'trae'].every((id) => P.providerLoginScript(id, 'C:\\any\\cli.exe') === null));
  ok('providers: no login script without a CLI path',
    P.providerLoginScript('devin', '') === null);
  // Copilot's credentials belong to the GitHub CLI, which is a different binary
  // from the provider's own: auth.cli must win over whatever detection passed in.
  const ghHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-gh-'));
  fs.mkdirSync(path.join(ghHome, 'GitHub CLI'), { recursive: true });
  const ghExe = path.join(ghHome, 'GitHub CLI', 'gh.exe');
  fs.writeFileSync(ghExe, 'x');
  process.env.FF_PROVIDER_HOME_COPILOT = ghHome;
  const script = P.providerLoginScript('copilot', 'C:\\wrong\\copilot.exe');
  process.env.FF_PROVIDER_HOME_COPILOT = path.join(os.tmpdir(), 'ff-no-gh-here');
  const scriptNoGh = P.providerLoginScript('copilot', '');
  const noCli = await P.checkProviderAuth('copilot', '', true);
  delete process.env.FF_PROVIDER_HOME_COPILOT;
  P.invalidateProviderAuth();
  ok('providers: the login script uses the credential CLI, not the provider CLI',
    !!script && script.lines.some((l) => l.includes(`"${ghExe}" "auth" "login"`))
    && script.lines.some((l) => l.includes('"auth" "status"'))
    && !JSON.stringify(script.lines).includes('copilot.exe'),
    JSON.stringify(script && script.lines.slice(0, 6)));
  ok('providers: no credential CLI anywhere -> no login script',
    scriptNoGh === null);
  ok('providers: missing CLI reports not-connected instead of throwing',
    noCli.loggedIn === false && noCli.canLogin === false && /not found/i.test(noCli.detail),
    JSON.stringify(noCli));
  const inApp = await P.checkProviderAuth('cursor', 'C:\\any\\cursor.exe', true);
  ok('providers: in-app provider offers to open the editor, never claims a login',
    inApp.kind === 'app' && inApp.canLogin === false && inApp.canOpen === true
    && inApp.loggedIn === false, JSON.stringify(inApp).slice(0, 120));

  // Model catalogues and the cross-provider mapping that keeps a flow runnable
  // on whichever executor is selected.
  ok('providers: every catalogue offers a real choice',
    P.PROVIDER_IDS.every((id) => P.providerModels(id).length >= 3),
    JSON.stringify(P.PROVIDER_IDS.map((id) => [id, P.providerModels(id).length])));
  ok('providers: model support is exact and empty means inherit',
    P.providerSupportsModel('trae', 'auto') && !P.providerSupportsModel('trae', 'claude-opus-5-max')
    && P.providerSupportsModel('cursor', ''));
  ok('providers: a supported model is never rewritten',
    P.mapModelToProvider('composer-1', 'cursor') === 'composer-1');
  ok('providers: an unsupported model lands on the same family elsewhere',
    P.mapModelToProvider('claude-sonnet-5-high', 'trae').startsWith('claude'),
    P.mapModelToProvider('claude-sonnet-5-high', 'trae'));
  ok('providers: a level word survives when the target has that variant',
    P.mapModelToProvider('gpt-5-mini', 'copilot') === 'gpt-5-mini',
    P.mapModelToProvider('gpt-5-mini', 'copilot'));
  ok('providers: a model with no counterpart falls back to the provider default',
    P.mapModelToProvider('swe-1-7-lightning', 'trae') === P.providerDefaultModel('trae'),
    P.mapModelToProvider('swe-1-7-lightning', 'trae'));
  ok('providers: every mapping result is actually supported',
    ['claude-opus-5-max', 'gpt-5', 'swe-1-7-lightning', 'gemini-3-7-flash-high', 'sonnet']
      .every((m) => P.PROVIDER_IDS.every((id) => P.providerSupportsModel(id, P.mapModelToProvider(m, id)))));
  const bulk = P.mapModelsToProvider(['composer-1', 'claude-opus-5-max', 'composer-1'], 'cursor');
  ok('providers: bulk mapping dedupes and reports only real changes',
    bulk.map['composer-1'] === 'composer-1' && bulk.changed.length === 1
    && bulk.changed[0].from === 'claude-opus-5-max', JSON.stringify(bulk.changed));

  // Flow filtering rule: absent field = unrestricted, [] = hidden everywhere.
  ok('providers: flow without a providers field is unrestricted',
    P.PROVIDER_IDS.every((id) => P.flowSupportsProvider({ name: 'x' }, id)));
  ok('providers: flow restricted to one provider hides from the others',
    P.flowSupportsProvider({ providers: ['cursor'] }, 'cursor')
    && !P.flowSupportsProvider({ providers: ['cursor'] }, 'devin'));
  ok('providers: empty providers array hides the flow everywhere',
    P.PROVIDER_IDS.every((id) => !P.flowSupportsProvider({ providers: [] }, id)));

  // A bogus home override must never throw and must detect nothing.
  process.env.FF_PROVIDER_HOME_CURSOR = path.join(os.tmpdir(), 'ff-no-such-editor');
  const bogus = await P.detectProvider('cursor', null);
  delete process.env.FF_PROVIDER_HOME_CURSOR;
  ok('providers: missing editor -> installed:false, no modules, no throw',
    bogus.installed === false && bogus.modules.length === 0 && bogus.missing.length > 0,
    JSON.stringify({ i: bogus.installed, m: bogus.modules.length }));
  let unknownThrew = false;
  try { await P.detectProvider('nope', null); } catch { unknownThrew = true; }
  ok('providers: unknown id rejected', unknownThrew);

  // In-app sign-in is READ from the editor's own JSON store, never guessed. The
  // fake home below stands in for %APPDATA%\Trae.
  const traeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-trae-'));
  const traeStore = path.join(traeHome, 'Trae', 'User', 'globalStorage');
  const traeApp = path.join(traeHome, 'Programs', 'Trae');
  fs.mkdirSync(traeStore, { recursive: true });
  fs.mkdirSync(traeApp, { recursive: true });
  fs.writeFileSync(path.join(traeApp, 'Trae.exe'), 'x');
  fs.mkdirSync(path.join(traeHome, 'Trae', 'User'), { recursive: true });
  fs.writeFileSync(path.join(traeHome, 'Trae', 'User', 'settings.json'), '{}');
  const SECRET = 'tok_' + 'z'.repeat(200);
  const writeStore = (obj) => fs.writeFileSync(path.join(traeStore, 'storage.json'), JSON.stringify(obj));
  process.env.FF_PROVIDER_HOME_TRAE = traeHome;
  writeStore({
    'iCubeAuthInfo://icube.cloudide': SECRET,
    'iCubeEntitlementInfo://icube.cloudide': JSON.stringify({ identityStr: 'Pro', hasPackage: true }),
  });
  P.invalidateProviderAuth();
  const traeIn = await P.checkProviderAuth('trae', await P.detectProvider('trae', null), true);
  ok('providers: in-app login is read from the editor store, with the plan label',
    traeIn.kind === 'app' && traeIn.known === true && traeIn.loggedIn === true
    && traeIn.account === 'Pro' && traeIn.canOpen === true,
    JSON.stringify({ k: traeIn.known, l: traeIn.loggedIn, a: traeIn.account }));
  ok('providers: the session token never leaves the reader',
    !JSON.stringify(traeIn).includes(SECRET) && !JSON.stringify(traeIn).includes('z'.repeat(40)));
  writeStore({ 'iCubeAuthInfo://icube.cloudide': '' });
  P.invalidateProviderAuth();
  const traeOut = await P.checkProviderAuth('trae', await P.detectProvider('trae', null), true);
  ok('providers: an emptied session key reads as signed out, not as unknown',
    traeOut.known === true && traeOut.loggedIn === false, JSON.stringify(traeOut.detail));
  fs.rmSync(path.join(traeStore, 'storage.json'));
  P.invalidateProviderAuth();
  const traeUnknown = await P.checkProviderAuth('trae', await P.detectProvider('trae', null), true);
  ok('providers: no store on disk -> unknown, never a confident "logged out"',
    traeUnknown.known === false && traeUnknown.loggedIn === false && traeUnknown.canOpen === true);
  delete process.env.FF_PROVIDER_HOME_TRAE;
  P.invalidateProviderAuth();

  // An app-kind provider that is not installed must not offer to open anything.
  process.env.FF_PROVIDER_HOME_CURSOR = path.join(os.tmpdir(), 'ff-no-such-editor');
  const noCursor = await P.checkProviderAuth('cursor', await P.detectProvider('cursor', null), true);
  delete process.env.FF_PROVIDER_HOME_CURSOR;
  P.invalidateProviderAuth();
  ok('providers: a missing app offers no open button',
    noCursor.canOpen === false && noCursor.canLogin === false && /not installed/i.test(noCursor.detail),
    JSON.stringify(noCursor.detail));

  // Copilot is an extension: VS Code alone must not count as "Copilot installed".
  const copHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cop-'));
  fs.mkdirSync(path.join(copHome, 'Code', 'User'), { recursive: true });
  fs.writeFileSync(path.join(copHome, 'Code', 'User', 'settings.json'), '{}');
  process.env.FF_PROVIDER_HOME_COPILOT = copHome;
  const copBare = await P.detectProvider('copilot', null);
  // A second home, because detectProvider caches per (id, project, override).
  const copHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cop2-'));
  fs.mkdirSync(path.join(copHome2, '.vscode', 'extensions', 'github.copilot-1.2.3'), { recursive: true });
  process.env.FF_PROVIDER_HOME_COPILOT = copHome2;
  const copExt = await P.detectProvider('copilot', null);
  delete process.env.FF_PROVIDER_HOME_COPILOT;
  ok('providers: VS Code without the Copilot extension is not Copilot',
    copBare.installed === false, JSON.stringify(copBare.editorPath));
  ok('providers: a version-stamped extension folder is detected',
    copExt.installed === true && /github\.copilot-1\.2\.3$/.test(copExt.editorPath || ''),
    JSON.stringify(copExt.editorPath));

  // Workspace module detection against a fabricated project.
  const modProj = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mods-'));
  const write = (rel, body) => {
    const f = path.join(modProj, ...rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  };
  write(['.github', 'prompts', 'coder.prompt.md'], '# coder prompt');
  write(['.github', 'copilot-instructions.md'], '# rules');
  write(['.cursor', 'rules', 'x.mdc'], '# cursor rule');
  write(['.trae', 'rules', 'y.md'], '# trae rule');
  write(['.trae', 'agents', 'tester.md'], '# trae tester agent');
  const detCopilot = await P.detectProvider('copilot', modProj);
  const detCursor = await P.detectProvider('cursor', modProj);
  const detTrae = await P.detectProvider('trae', modProj);
  ok('providers: copilot workspace modules found',
    detCopilot.modules.some((m) => m.label === '.github/prompts/coder.prompt.md' && m.kind === 'prompt')
    && detCopilot.modules.some((m) => m.kind === 'instruction'),
    JSON.stringify(detCopilot.modules.map((m) => m.label)));
  ok('providers: cursor workspace modules found',
    detCursor.modules.some((m) => m.label === '.cursor/rules/x.mdc' && m.scope === 'workspace'),
    JSON.stringify(detCursor.modules.map((m) => m.label)));
  ok('providers: trae workspace modules found',
    detTrae.modules.some((m) => m.label === '.trae/rules/y.md')
    && detTrae.modules.some((m) => m.label === '.trae/agents/tester.md'),
    JSON.stringify(detTrae.modules.map((m) => m.label)));
  ok('providers: module entries carry kind/scope/size/mtime',
    detTrae.modules.every((m) => m.kind && m.scope && typeof m.size === 'number' && typeof m.mtime === 'number'));

  // The built flow must be valid flow JSON AND survive the graph editor.
  const builtFlow = P.buildFlowFromModules('trae', detTrae);
  const gateOkValues = ['auto', 'terminal', 'dashboard', 'default'];
  ok('providers: built flow is valid flow JSON',
    builtFlow.name === 'trae-detected' && builtFlow.title && builtFlow.titleAr
    && JSON.stringify(builtFlow.providers) === JSON.stringify(['trae'])
    && builtFlow.stages.length >= 1
    && builtFlow.stages.every((s) => s.id && s.titleAr && s.artifact && gateOkValues.includes(s.gate))
    && new Set(builtFlow.stages.map((s) => s.id)).size === builtFlow.stages.length,
    JSON.stringify(builtFlow.stages.map((s) => s.id)));
  ok('providers: built flow gates only on the last stage',
    builtFlow.stages[builtFlow.stages.length - 1].gate === 'default'
    && !!builtFlow.stages[builtFlow.stages.length - 1].gateQuestionAr
    && builtFlow.stages.slice(0, -1).every((s) => s.gate === 'auto'));
  ok('providers: built flow collects context first',
    JSON.stringify(builtFlow.stages[0].pre) === JSON.stringify(['scripts/collect-context.mjs'])
    && fs.existsSync(path.join(WORKBENCH, 'scripts', 'collect-context.mjs')));
  ok('providers: built flow cites no machine-specific path',
    !/[A-Za-z]:\\+(Users|New folder)/.test(JSON.stringify(builtFlow)));
  MOD_ROUNDTRIP.flowToGraph(builtFlow);
  const builtBack = MOD_ROUNDTRIP.graphToFlow(builtFlow.name);
  ok('providers: built flow round-trips through the graph editor',
    !builtBack.error && builtBack.flow.stages.length === builtFlow.stages.length
    && JSON.stringify(builtBack.flow.providers) === JSON.stringify(['trae']),
    JSON.stringify(builtBack.error || ''));

  // Nothing detected -> a flagged single-stage skeleton, still valid.
  const empty = P.buildFlowFromModules('cursor', { modules: [] });
  ok('providers: empty detection builds a flagged skeleton',
    empty.detected === false && empty.stages.length === 1
    && empty.stages[0].artifact === 'modules.md' && !!empty.stages[0].titleAr);

  fs.rmSync(modProj, { recursive: true, force: true });
}

// ---------- 2. spin up server on a scratch project ----------
console.log('# server checks');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-'));
fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'ff-scratch', version: '1.0.0' }, null, 2));
// The test server gets its OWN registry inside the scratch dir (FF_REGISTRY):
// a dashboard running at the same time must never see test projects, and its
// active project must survive a test run.
const registryFile = path.join(scratch, 'projects.test.json');
const realRegistry = path.join(DASHBOARD, 'projects.local.json');
const realRegistryBefore = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null;

// Fake Devin CLI: version/auth commands exit instantly; -p runs stream
// ANSI-colored lines for ~4s so stop/409/strip behavior can be exercised.
const fakeCli = path.join(scratch, 'fake-devin.mjs');
fs.writeFileSync(fakeCli, [
  "const args = process.argv.slice(2).join(' ');",
  "console.log('FAKE-DEVIN args: ' + args);",
  "if (args.startsWith('auth') && process.env.FAKE_AUTH === 'no') { console.log('Not logged in.'); process.exit(1); }",
  "if (args.startsWith('models list')) {",
  "  console.log('Available models (2 families)');",
  "  console.log('Claude Opus 5 (claude-opus-5)');",
  "  console.log('  aliases: opus');",
  "  console.log('  claude-opus-5-low     Claude Opus 5 Low  [1M context]');",
  "  console.log('  claude-opus-5-max     Claude Opus 5 Max  [1M context]');",
  "  console.log('');",
  "  console.log('SWE-1.7 (swe-1.7)');",
  "  console.log('  swe-1-7               SWE-1.7 Max  [262K context]');",
  '  process.exit(0);',
  '}',
  "if (args.includes('--version') || args.startsWith('auth')) process.exit(0);",
  'let i = 0;',
  'const t = setInterval(() => {',
  "  console.log('\\x1b[1;38;5;81mstream\\x1b[0m line ' + (++i));",
  '  if (i >= 20) { clearInterval(t); process.exit(0); }',
  '}, 200);',
].join('\n'));

// FF_PROVIDER_HOME_CURSOR points at nothing on purpose: the login test below
// must hit the "app not found" branch on EVERY machine, never open a real editor.
const server = spawn(process.execPath, [path.join(DASHBOARD, 'server.mjs'), scratch, String(PORT)],
  { stdio: 'pipe', env: { ...process.env, DEVIN_CLI: fakeCli, FF_NO_ACP: '1', FF_REGISTRY: registryFile,
    FF_PROVIDER_HOME_CURSOR: path.join(scratch, 'no-such-cursor') } });
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

try {
  await sleep(900);
  ok('server started', serverOut.includes('FlowForge dashboard'), serverOut.slice(0, 200));

  // UI served
  const ui = await fetch(BASE + '/').then((r) => r.text());
  ok('GET / serves UI', ui.includes('FlowForge') && ui.includes('const I18N'));

  // Studio surface served on both aliases
  const stuRes = await fetch(BASE + '/studio');
  const stuHtml = await stuRes.text();
  ok('GET /studio serves studio', stuRes.status === 200 && stuRes.headers.get('content-type') === 'text/html; charset=utf-8' && stuHtml.includes('id="chain"'), String(stuRes.status));
  const stuAlt = await fetch(BASE + '/studio.html').then((r) => r.text());
  ok('GET /studio.html serves studio', stuAlt.includes('id="intentRow"'));

  // health: liveness endpoint (requires no project state)
  const health = await get('/api/health');
  ok('health: ok:true', health.ok === true, JSON.stringify(health));
  ok('health: uptimeSec non-negative integer', Number.isInteger(health.uptimeSec) && health.uptimeSec >= 0, JSON.stringify(health));

  // state
  const st = await get('/api/state');
  ok('state: active project is scratch', st.project && st.project.toLowerCase() === scratch.toLowerCase(), st.project);
  ok('state: flows listed', Array.isArray(st.flows) && st.flows.includes('task') && st.flows.includes('understand'));
  ok('state: settings default', st.settings && st.settings.gateMode === 'default');
  ok('state: agent models exposed', st.models && st.models.thinker === 'opus' && st.models.tester === 'sonnet' && st.models.shipper === 'swe', JSON.stringify(st.models));

  // settings roundtrip + validation
  const s1 = await post('/api/settings', { gateMode: 'dashboard' });
  ok('settings: set gateMode', s1.ok && s1.settings.gateMode === 'dashboard');
  const s2 = await post('/api/settings', { gateMode: 'nope' });
  ok('settings: rejects bad gateMode', !!s2.error);
  const s3 = await post('/api/settings', { refineProvider: 'nope' });
  ok('settings: rejects bad refineProvider', !!s3.error);

  // executor providers over HTTP. Only in-app providers are exercised for
  // login here: asking a CLI provider to log in would open a real terminal.
  const provList = await get('/api/providers');
  ok('providers api: lists all four with a selection',
    Array.isArray(provList.providers) && provList.providers.length === 4
    && provList.providers.every((p) => typeof p.installed === 'boolean' && typeof p.runnable === 'boolean')
    && provList.selected === 'devin', JSON.stringify(provList.selected));
  const authCursor = await get('/api/provider-auth?id=cursor');
  ok('providers api: in-app provider reports kind app with a bilingual reason',
    authCursor.auth && authCursor.auth.kind === 'app' && authCursor.auth.canLogin === false
    && !!authCursor.auth.reasonAr, JSON.stringify(authCursor.auth || {}).slice(0, 140));
  const authBad = await get('/api/provider-auth?id=nope');
  ok('providers api: unknown id rejected on auth', !!authBad.error);
  const loginNo = await post('/api/provider/login', { id: 'cursor' });
  ok('providers api: login refused when the editor is not on the machine',
    loginNo.error === 'app_not_found', JSON.stringify(loginNo));
  const loginBad = await post('/api/provider/login', { id: 'nope' });
  ok('providers api: login rejects an unknown id', !!loginBad.error);
  const rt = await post('/api/retarget-models', { provider: 'trae', models: ['claude-opus-5-max', 'auto'] });
  ok('providers api: retarget maps only what the provider lacks',
    rt.map && rt.map.auto === 'auto' && rt.map['claude-opus-5-max'].startsWith('claude')
    && rt.changed.length === 1, JSON.stringify(rt));
  const rtBad = await post('/api/retarget-models', { provider: 'trae', models: 'nope' });
  ok('providers api: retarget rejects a non-array', !!rtBad.error);

  // Bulk flow retarget: preview writes nothing, applying leaves the runnable
  // Devin originals alone and puts the retargeted pipeline in its own copy.
  const PROV = await import('../providers.mjs');
  const flowsDir = path.join(WORKBENCH, 'flows');
  const flowsBefore = new Set(fs.readdirSync(flowsDir));
  const taskBefore = fs.readFileSync(path.join(flowsDir, 'task.json'), 'utf8');
  const prev = await post('/api/retarget-flows', { provider: 'trae' });
  ok('retarget-flows: preview reports changes without touching a file',
    prev.applied === false && prev.totalChanges > 0
    && prev.flows.some((f) => f.name === 'task' && f.target === 'task-trae' && !f.inPlace)
    && fs.readFileSync(path.join(flowsDir, 'task.json'), 'utf8') === taskBefore,
    JSON.stringify({ applied: prev.applied, total: prev.totalChanges }));
  const applied = await post('/api/retarget-flows', { provider: 'trae', apply: true });
  const copyPath = path.join(flowsDir, 'task-trae.json');
  const copy = fs.existsSync(copyPath) ? JSON.parse(fs.readFileSync(copyPath, 'utf8')) : null;
  ok('retarget-flows: apply writes a provider copy and keeps the original intact',
    applied.applied === true && !!copy
    && fs.readFileSync(path.join(flowsDir, 'task.json'), 'utf8') === taskBefore,
    JSON.stringify({ applied: applied.applied, copy: !!copy }));
  ok('retarget-flows: the copy is restricted and fully supported by that provider',
    !!copy && JSON.stringify(copy.providers) === JSON.stringify(['trae'])
    && copy.name === 'task-trae'
    && copy.stages.every((s) => !s.model || PROV.providerSupportsModel('trae', s.model)),
    JSON.stringify(copy && copy.stages.map((s) => s.model)));
  // Re-running must update that copy in place instead of nesting suffixes.
  const again = await post('/api/retarget-flows', { provider: 'trae', apply: true });
  ok('retarget-flows: a second pass creates no task-trae-trae',
    !fs.existsSync(path.join(flowsDir, 'task-trae-trae.json'))
    && again.flows.some((f) => f.name === 'task-trae' && f.inPlace === true));
  // Remove ONLY what this test created - a real -trae flow of the user's must survive.
  for (const f of fs.readdirSync(flowsDir)) {
    if (!flowsBefore.has(f)) fs.unlinkSync(path.join(flowsDir, f));
  }
  // NEVER apply for the in-place provider here: its target IS the real flow file.
  // Devin is judged against the LIVE `models list` (the fake CLI serves one), so
  // an id that catalogue contains must be reported as needing no change.
  const devinPrev = await post('/api/retarget-flows', { provider: 'devin' });
  ok('retarget-flows: the in-place provider is preview-only and keeps its files byte-identical',
    devinPrev.applied === false && devinPrev.flows.every((f) => f.inPlace)
    && fs.readFileSync(path.join(flowsDir, 'task.json'), 'utf8') === taskBefore,
    JSON.stringify({ applied: devinPrev.applied }));
  const devinMap = await post('/api/retarget-models', { provider: 'devin', models: ['claude-opus-5-max', 'swe-1-7'] });
  ok('retarget-models: models the live catalogue lists are left alone',
    devinMap.changed.length === 0 && devinMap.map['claude-opus-5-max'] === 'claude-opus-5-max'
    && devinMap.map['swe-1-7'] === 'swe-1-7', JSON.stringify(devinMap));
  const rtfBad = await post('/api/retarget-flows', { provider: 'nope' });
  ok('retarget-flows: unknown provider rejected', !!rtfBad.error);
  const mDevin = await get('/api/models?provider=devin');
  const mTrae = await get('/api/models?provider=trae');
  ok('providers api: model list follows the provider',
    Array.isArray(mDevin.families) && Array.isArray(mTrae.families)
    && mTrae.source === 'registry'
    && JSON.stringify(mDevin.families) !== JSON.stringify(mTrae.families));

  // prompt refiner: the offline provider must work with no model and no key,
  // and the stored API key must never travel back to the browser.
  const ref1 = await post('/api/refine', { text: '', flow: 'task' });
  ok('refine: empty text rejected', !!ref1.error);
  await post('/api/settings', { refineProvider: 'local', refineApiKey: 'secret-test-key' });
  const ref2 = await post('/api/refine', { text: 'اعمل صفحة تسجيل دخول', flow: 'task' });
  ok('refine: offline provider answers', ref2.ok && ref2.via === 'offline'
    && ref2.prompt.includes('اعمل صفحة تسجيل دخول') && ref2.prompt.includes('acceptance criteria'), JSON.stringify(ref2).slice(0, 160));
  const sGet = await get('/api/settings');
  ok('refine: api key never leaves the server',
    sGet.settings.refineApiKey === undefined && sGet.settings.refineApiKeySet === true);

  // optimize mode: sharpens a prompt that already exists, and must never drop
  // what the user wrote (the offline template proves the contract with no model).
  const written = 'Add a /health endpoint to server.mjs that returns 200 and the uptime';
  const opt = await post('/api/refine', { text: written, flow: 'task', mode: 'optimize' });
  ok('refine: optimize keeps the user wording', opt.ok && opt.mode === 'optimize'
    && opt.prompt.includes('/health endpoint to server.mjs'), JSON.stringify(opt).slice(0, 160));
  ok('refine: optimize adds the verification ask', /acceptance criteria/i.test(opt.prompt), opt.prompt.slice(0, 160));
  const gen = await post('/api/refine', { text: written, flow: 'task', mode: 'generate' });
  ok('refine: generate is a different job from optimize',
    gen.mode === 'generate' && gen.prompt !== opt.prompt, JSON.stringify(gen).slice(0, 140));
  const optBad = await post('/api/refine', { text: written, mode: 'sharpen' });
  ok('refine: unknown mode rejected', !!optBad.error, JSON.stringify(optBad));
  await post('/api/settings', { refineProvider: 'auto' });

  // folder picker: drives at the root, sub-directories with project hints
  const br0 = await get('/api/browse');
  ok('browse: lists drives at the root', br0.roots === true && br0.drives.length > 0
    && Array.isArray(br0.shortcuts), JSON.stringify(br0.drives));
  fs.mkdirSync(path.join(scratch, 'inner-proj', '.workbench'), { recursive: true });
  const br1 = await get('/api/browse?path=' + encodeURIComponent(scratch));
  const inner = (br1.entries || []).find((e) => e.name === 'inner-proj');
  ok('browse: lists sub-directories with project hints',
    br1.path.toLowerCase() === scratch.toLowerCase() && !!inner && inner.workbench === true,
    JSON.stringify(br1.entries));
  ok('browse: parent is reported for navigation', typeof br1.parent === 'string' && br1.parent.length > 0);
  const br2 = await get('/api/browse?path=' + encodeURIComponent(path.join(scratch, 'nope-missing')));
  ok('browse: missing directory rejected', !!br2.error);

  // skills API
  const sk = await get('/api/skills');
  ok('skills: lists built-ins', sk.skills.includes('flow') && sk.skills.includes('understand'), JSON.stringify(sk.skills));
  const sk1 = await get('/api/skill?name=flow');
  ok('skills: get flow skill', sk1.content.includes('FlowForge orchestrator'));
  await post('/api/skill', { name: 'tmp-test-skill', content: '---\nname: tmp-test-skill\n---\nTest.' });
  const sk2 = await get('/api/skills');
  ok('skills: create new skill', sk2.skills.includes('tmp-test-skill'));
  const sk3 = await get('/api/skill?name=tmp-test-skill');
  ok('skills: read new skill back', sk3.content.includes('Test.'));

  // agents API
  const ag = await get('/api/agents');
  ok('agents: lists 6 roles', ag.agents.length >= 6, JSON.stringify(ag.agents));
  const tmpRole = '---\nname: tmp-test-role\ndescription: temp\nmodel: sonnet\nallowed-tools:\n  - read\n---\n\nbody\n';
  await post('/api/agent', { name: 'tmp-test-role', content: tmpRole });
  const agAfter = await get('/api/agents');
  ok('agents: custom role created', agAfter.agents.includes('tmp-test-role.md'), agAfter.agents.join(','));
  const delCore = await fetch(BASE + '/api/agent?name=coder', { method: 'DELETE' });
  ok('agents: core role delete blocked', delCore.status === 400);
  await fetch(BASE + '/api/agent?name=tmp-test-role', { method: 'DELETE' });
  const agGone = await get('/api/agents');
  ok('agents: custom role deleted', !agGone.agents.includes('tmp-test-role'));

  // flows API: create, get, delete; builtin protected
  await post('/api/flow', { name: 'tmp-test-flow', content: JSON.stringify({ name: 'tmp-test-flow', stages: [] }) });
  const fl = await get('/api/flow?name=tmp-test-flow');
  ok('flows: create + get', fl.content.includes('tmp-test-flow'));
  const fdel = await del('/api/flow?name=tmp-test-flow');
  ok('flows: delete', fdel.ok === true);
  const fdel2 = await del('/api/flow?name=task');
  ok('flows: builtin delete blocked', !!fdel2.error);

  // Studio-authored flow: same API, first-class citizen in state.flows
  {
    const sName = 'studio-abc123';
    const sFlow = {
      name: sName, title: 'Studio pipeline', titleAr: 'فلو الاستوديو',
      description: 'Studio-authored pipeline.', defaultGate: 'terminal',
      stages: [{
        id: 'think', title: 'Think & plan', titleAr: 'التفكير والتخطيط', agent: 'thinker',
        prompt: 'Task: {TASK}', pre: [], post: [], gate: 'dashboard',
        gateQuestion: 'Proceed?', gateQuestionAr: 'نكمل؟', artifact: 'plan.md', done: ['plan.md exists'],
      }],
    };
    await post('/api/flow', { name: sName, content: JSON.stringify(sFlow, null, 2) });
    const stS = await get('/api/state');
    ok('studio flow: appears in state.flows', (stS.flows || []).includes(sName), JSON.stringify(stS.flows));
    const back = JSON.parse((await get('/api/flow?name=' + sName)).content);
    ok('studio flow: schema-compatible (bilingual stages)',
      back.name === sName && !!back.titleAr && back.stages.every((s) => s.title && s.titleAr && s.agent && s.prompt && s.artifact));
    ok('studio flow: name matches UI naming convention', /^[a-z0-9][a-z0-9-]*$/.test(back.name));
    const sdel = await del('/api/flow?name=' + sName);
    ok('studio flow: removable', sdel.ok === true);
  }

  // export endpoint: same converter library, reached over HTTP
  {
    const fmts = await get('/api/formats');
    ok('formats: endpoint lists the registry',
      Array.isArray(fmts.formats) && fmts.formats.some((f) => f.id === 'pdf' && f.ext === '.pdf')
      && fmts.formats.some((f) => f.id === 'xlsx'), JSON.stringify(fmts.formats || []).slice(0, 120));

    const artDir = path.join(scratch, '.workbench', 'artifacts');
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(path.join(artDir, 'report.md'),
      '# Report\n\n| Item | Value |\n|---|---|\n| Alpha | 10 |\n\nDone.\n', 'utf8');

    const ex = await post('/api/export', { name: 'report.md', to: 'docx' });
    ok('export: artifact converted through the API',
      ex.ok === true && ex.format === 'docx' && ex.size > 500
      && fs.existsSync(ex.out) && ex.out.includes(path.join('.workbench', 'exports')), JSON.stringify(ex));
    const exXlsx = await post('/api/export', { name: 'report.md', to: 'xlsx' });
    ok('export: second format lands beside the first',
      exXlsx.ok === true && fs.existsSync(exXlsx.out) && exXlsx.out.endsWith('.xlsx'), JSON.stringify(exXlsx));
    const exBadFmt = await post('/api/export', { name: 'report.md', to: 'exe' });
    ok('export: unknown format rejected', !!exBadFmt.error, JSON.stringify(exBadFmt));
    const exMissing = await post('/api/export', { name: 'nope.md', to: 'pdf' });
    ok('export: missing artifact rejected', !!exMissing.error, JSON.stringify(exMissing));
    const exTraversal = await post('/api/export', { name: '../../secret.md', to: 'txt' });
    ok('export: path traversal rejected', !!exTraversal.error, JSON.stringify(exTraversal));
  }

  // inbox
  const inb = await post('/api/inbox', { text: 'test note' });
  ok('inbox: append', inb.ok === true);
  ok('inbox: file written', fs.readFileSync(path.join(scratch, '.workbench', 'inbox.md'), 'utf8').includes('test note'));

  // activity watcher: create a file and expect an event
  const before = await get('/api/activity');
  fs.writeFileSync(path.join(scratch, 'watched-file.txt'), 'hello');
  await sleep(700);
  const after = await get('/api/activity?since=' + encodeURIComponent(before.now));
  ok('activity: file event captured', after.events.some((e) => e.path.includes('watched-file.txt')), JSON.stringify(after.events.slice(0, 3)));

  // activity: noise filtered (state.json writes must not appear)
  fs.mkdirSync(path.join(scratch, '.workbench'), { recursive: true });
  const mark = (await get('/api/activity')).now;
  fs.writeFileSync(path.join(scratch, '.workbench', 'state.json'), '{}');
  await sleep(700);
  const noise = await get('/api/activity?since=' + encodeURIComponent(mark));
  ok('activity: state.json filtered out', !noise.events.some((e) => e.path.includes('state.json')));

  // changes endpoint (scratch is not a git repo -> git:false)
  const chg = await get('/api/changes');
  ok('changes: non-git reported cleanly', chg.git === false);

  // gate protocol end-to-end (approve)
  const gateProc = spawn(process.execPath, [path.join(WORKBENCH, 'scripts', 'gate-wait.mjs'), scratch, 'test-stage', 'Q?', 'س؟', '30'], { stdio: 'pipe' });
  let gateOut = '';
  gateProc.stdout.on('data', (d) => { gateOut += d; });
  await sleep(800);
  const gstate = await get('/api/state');
  ok('gate: visible in state (with questionAr)', gstate.gate && gstate.gate.stage === 'test-stage' && gstate.gate.questionAr === 'س؟');
  const cmd = await post('/api/command', { stage: 'test-stage', decision: 'approve', note: 'ok' });
  ok('gate: command accepted', cmd.ok === true);
  const gateExit = await new Promise((r) => gateProc.on('exit', r));
  ok('gate: approve -> exit 0 + note', gateExit === 0 && gateOut.includes('DECISION: approve') && gateOut.includes('NOTE: ok'), gateOut);

  // gate: 409 when no gate pending
  const cmd409 = await post('/api/command', { stage: 'test-stage', decision: 'approve' });
  ok('gate: 409 when nothing pending', !!cmd409.error);

  // artifact traversal guard
  const trav = await fetch(BASE + '/api/artifact?name=..%5C..%5Cpackage.json');
  ok('artifact: traversal blocked', trav.status === 400);

  // CLI status endpoint (against the fake CLI)
  const cli = await get('/api/cli');
  ok('cli: found + authenticated (fake)', cli.found === true && cli.authenticated === true, JSON.stringify(cli));

  // model catalogue endpoint (parses `devin models list`)
  const mdl = await get('/api/models');
  const opusFam = (mdl.families || []).find((f) => f.slug === 'claude-opus-5');
  ok('models: families parsed from CLI output',
    mdl.source === 'cli' && mdl.families.length === 2, JSON.stringify(mdl).slice(0, 200));
  ok('models: aliases + level variants parsed',
    !!opusFam && opusFam.aliases.includes('opus') && opusFam.variants.length === 2
    && opusFam.variants[1].id === 'claude-opus-5-max'
    && opusFam.variants[1].label === 'Claude Opus 5 Max', JSON.stringify(opusFam));

  // headless runner lifecycle (against the fake CLI)
  const r0 = await get('/api/run');
  ok('run: no run yet', r0.exists === false);
  const r1 = await post('/api/run', { flow: 'task', task: 'demo run', gates: 'auto', speed: 'fast' });
  ok('run: started', r1.ok === true && typeof r1.pid === 'number', JSON.stringify(r1));
  const r409 = await post('/api/run', { flow: 'task', task: 'second', gates: 'auto' });
  ok('run: concurrent start blocked (409)', !!r409.error);
  await sleep(700);
  const r2 = await get('/api/run');
  ok('run: active with streamed lines', r2.active === true && r2.lines.some((l) => l.includes('FAKE-DEVIN args:')), JSON.stringify(r2.lines.slice(0, 2)));
  ok('run: prompt carries flow+task+gates', r2.lines.some((l) => l.includes('/flow task') && l.includes('demo run') && l.includes('--gates=auto')));
  ok('run: permission mode passed', r2.lines.some((l) => l.includes('--permission-mode dangerous')));
  ok('run: speed override reaches the prompt', r2.lines.some((l) => l.includes('--speed=fast')));
  ok('run: ansi codes stripped', r2.lines.some((l) => l.includes('stream line')) && r2.lines.every((l) => !l.includes('\u001b')), JSON.stringify(r2.lines.find((l) => l.includes('stream'))));
  const rstop = await post('/api/run/stop', {});
  ok('run: stop accepted', rstop.ok === true);
  let stopped = null;
  for (let i = 0; i < 20; i++) { await sleep(300); stopped = await get('/api/run'); if (!stopped.active) break; }
  ok('run: process terminated by stop', stopped && stopped.active === false && stopped.exitCode !== 0, `exit=${stopped && stopped.exitCode}`);
  const r3 = await post('/api/run', { flow: 'understand', gates: 'terminal', speed: 'flow' });
  ok('run: new run after stop allowed', r3.ok === true);
  const rFlowSpeed = await get('/api/run');
  ok('run: default speed adds no flag', rFlowSpeed.lines.every((l) => !l.includes('--speed=')),
    JSON.stringify(rFlowSpeed.lines.slice(0, 2)));
  let finished = null;
  for (let i = 0; i < 30; i++) { await sleep(300); finished = await get('/api/run'); if (!finished.active) break; }
  ok('run: understand run finished cleanly', finished && finished.exitCode === 0, `exit=${finished && finished.exitCode}`);
  ok('run: understand prompt shape', finished.lines.some((l) => l.includes('/understand --gates=terminal')));
  const rstop409 = await post('/api/run/stop', {});
  ok('run: stop without active run rejected', !!rstop409.error);

  // queue-wait.mjs contract: pending task consumed with exit 0
  {
    const qFile = path.join(scratch, '.workbench', 'queue.json');
    fs.mkdirSync(path.dirname(qFile), { recursive: true });
    fs.writeFileSync(qFile, JSON.stringify({ pending: { id: 'q1', flow: 'task', task: 'queued demo', gates: 'auto' }, stop: false }));
    const qw = spawn(process.execPath, [path.join(WORKBENCH, 'scripts', 'queue-wait.mjs'), scratch, '30'], { stdio: 'pipe' });
    let qOut = '';
    qw.stdout.on('data', (d) => { qOut += d; });
    const qExit = await new Promise((r) => qw.on('exit', r));
    ok('queue-wait: task consumed (exit 0 + TASK line)', qExit === 0 && qOut.includes('TASK:') && qOut.includes('queued demo'), qOut.trim().split('\n').pop());
    ok('queue-wait: heartbeat written', fs.existsSync(path.join(scratch, '.workbench', 'daemon.json')));
    // stop signal
    fs.writeFileSync(qFile, JSON.stringify({ pending: null, stop: true }));
    const qw2 = spawn(process.execPath, [path.join(WORKBENCH, 'scripts', 'queue-wait.mjs'), scratch, '30'], { stdio: 'pipe' });
    const qExit2 = await new Promise((r) => qw2.on('exit', r));
    ok('queue-wait: stop honored (exit 2)', qExit2 === 2);
  }

  // projects: add/activate/remove with messy input
  const scratch2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test2-'));
  const p1 = await post('/api/projects', { action: 'add', path: scratch2 });
  ok('projects: add + auto-activate', p1.active.toLowerCase() === scratch2.toLowerCase());
  const p2 = await post('/api/projects', { action: 'activate', path: scratch.toUpperCase() });
  ok('projects: activate case-insensitive', p2.active && p2.active.toLowerCase() === scratch.toLowerCase());
  const p3 = await post('/api/projects', { action: 'remove', path: scratch2 });
  ok('projects: remove', !p3.projects.some((x) => x.toLowerCase() === scratch2.toLowerCase()));
  fs.rmSync(scratch2, { recursive: true, force: true });
} finally {
  server.kill();
  // Cleanup: temp skill, temp scratch, restore registry
  fs.rmSync(path.join(WORKBENCH, 'skills', 'tmp-test-skill'), { recursive: true, force: true });
  fs.rmSync(path.join(WORKBENCH, 'flows', 'studio-abc123.json'), { force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  const realRegistryAfter = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null;
  ok('registry: the real projects.local.json is untouched by the test run',
    realRegistryAfter === realRegistryBefore);
}

// ---------- 3. queue-mode server (CLI unauthenticated + daemon heartbeat) ----------
console.log('# queue-mode checks');
{
  const scratch3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test3-'));
  const wb = path.join(scratch3, '.workbench');
  fs.mkdirSync(wb, { recursive: true });
  // Fresh fake CLI copy (the section-2 scratch dir is already deleted).
  const fakeCli3 = path.join(scratch3, 'fake-devin.mjs');
  fs.writeFileSync(fakeCli3, [
    "const args = process.argv.slice(2).join(' ');",
    "console.log('FAKE-DEVIN args: ' + args);",
    "if (args.startsWith('auth') && process.env.FAKE_AUTH === 'no') { console.log('Not logged in.'); process.exit(1); }",
    "if (args.includes('--version') || args.startsWith('auth')) process.exit(0);",
    'process.exit(0);',
  ].join('\n'));
  const PORT3 = PORT + 1;
  const base3 = `http://127.0.0.1:${PORT3}`;
  const g3 = (p) => fetch(base3 + p).then(j);
  const p3 = (p, b) => fetch(base3 + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(j);
  const server3 = spawn(process.execPath, [path.join(DASHBOARD, 'server.mjs'), scratch3, String(PORT3)],
    { stdio: 'pipe', env: { ...process.env, DEVIN_CLI: fakeCli3, FAKE_AUTH: 'no', FF_NO_ACP: '1',
      FF_REGISTRY: path.join(scratch3, 'projects.test.json') } });
  try {
    await sleep(900);
    // no daemon yet -> no executor
    const noExec = await p3('/api/run', { flow: 'task', task: 'x', gates: 'auto' });
    ok('queue: no executor rejected', noExec.error === 'no_executor', JSON.stringify(noExec));
    // fresh heartbeat -> queue accepted
    fs.writeFileSync(path.join(wb, 'daemon.json'), JSON.stringify({ aliveAt: new Date().toISOString(), pid: 1, status: 'listening' }));
    const q1 = await p3('/api/run', { flow: 'task', task: 'daemon demo', gates: 'dashboard' });
    ok('queue: run queued via daemon', q1.ok === true && q1.mode === 'queue', JSON.stringify(q1));
    const qFile = JSON.parse(fs.readFileSync(path.join(wb, 'queue.json'), 'utf8'));
    ok('queue: queue.json pending written', qFile.pending && qFile.pending.task === 'daemon demo');
    const q2 = await p3('/api/run', { flow: 'task', task: 'second', gates: 'auto' });
    ok('queue: double submit blocked', !!q2.error);
    const st3 = await g3('/api/state');
    ok('queue: state exposes daemon + queuePending', st3.daemon.alive === true && st3.queuePending && st3.queuePending.task === 'daemon demo');
    const dstop = await p3('/api/daemon/stop', {});
    ok('queue: daemon stop flag written', dstop.ok === true && JSON.parse(fs.readFileSync(path.join(wb, 'queue.json'), 'utf8')).stop === true);
  } finally {
    server3.kill();
    fs.rmSync(scratch3, { recursive: true, force: true });
  }
}

// ---------- 4. ACP client protocol (fake ACP agent over NDJSON) ----------
console.log('# acp client checks');
{
  const { startAcp } = await import(new URL('../acp-client.mjs', import.meta.url));
  const scratch4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test4-'));
  const fakeAcp = path.join(scratch4, 'fake-acp.mjs');
  fs.writeFileSync(fakeAcp, [
    "let buf='';",
    "process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){",
    'const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;',
    'const m=JSON.parse(line);',
    "const reply=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');",
    "if(m.method==='initialize'){reply({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});}",
    "else if(m.method==='session/new'){reply({jsonrpc:'2.0',id:m.id,result:{sessionId:'fake-session'}});}",
    "else if(m.method==='session/prompt'){",
    "const sid=m.params.sessionId;",
    "const note=(u)=>reply({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:u}});",
    "note({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'thinking...'}});",
    "note({sessionUpdate:'tool_call',toolCallId:'t1',title:'Read file'});",
    "note({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OK'}});",
    "reply({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});}",
    '}});',
  ].join('\n'));

  const updates = [];
  const handle = startAcp({
    cwd: scratch4, prompt: 'test', cliPath: fakeAcp,
    onUpdate: (u) => updates.push(u),
    timeoutMs: 20000,
  });
  const result = await handle.promise;
  handle.kill();
  await sleep(400); // let the fake agent process exit before removing its dir
  try { fs.rmSync(scratch4, { recursive: true, force: true }); } catch {}
  ok('acp: session created + prompt completed', result.sessionId === 'fake-session' && result.stopReason === 'end_turn');
  ok('acp: thought chunk streamed', updates.some((u) => u.sessionUpdate === 'agent_thought_chunk' && u.content.text === 'thinking...'));
  ok('acp: tool call streamed', updates.some((u) => u.sessionUpdate === 'tool_call' && u.title === 'Read file'));
  ok('acp: message chunk streamed', updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && u.content.text === 'OK'));
}

// ---------- 5. document conversion (scripts/convert-doc.mjs) ----------
console.log('# document conversion');
{
  const conv = path.join(WORKBENCH, 'scripts', 'convert-doc.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-conv-'));
  const run = (args) => spawnSync(process.execPath, [conv, ...args], { encoding: 'utf8' });
  const sample = [
    '# Deliverable report',
    '',
    'Intro with **bold**, *italic*, `code` and a [link](https://example.com).',
    '',
    '## Second section',
    '- first bullet',
    '- a very long bullet that has to wrap because it keeps going well past the width of one printed line in the page column',
    '',
    '1. numbered one',
    '2. numbered two',
    '',
    '> quoted remark',
    '',
    '```',
    'const x = 1;',
    '```',
    '',
    '---',
    '',
    'نص عربي للتجربة.',
    '',
  ].join('\n');
  // Written WITH a BOM on purpose: Windows editors add one and it used to eat the first heading.
  const docFile = path.join(dir, 'doc.md');
  fs.writeFileSync(docFile, '\uFEFF' + sample, 'utf8');

  const help = run(['--help']);
  ok('convert: --help lists formats and methods',
    help.status === 0 && ['pdf', 'docx', 'html', 'txt'].every((f) => help.stdout.includes(f))
    && ['builtin', 'browser', 'auto'].every((m) => help.stdout.includes(m)), help.stdout.slice(0, 80));

  const pdf = run([docFile, '--to', 'pdf', '--method', 'builtin', '--quiet']);
  const pdfFile = path.join(dir, 'doc.pdf');
  const pdfBuf = fs.existsSync(pdfFile) ? fs.readFileSync(pdfFile) : Buffer.alloc(0);
  ok('convert: md -> pdf (builtin) writes a valid PDF',
    pdf.status === 0 && pdfBuf.subarray(0, 7).toString('latin1') === '%PDF-1.'
    && pdfBuf.subarray(-7).toString('latin1').includes('%%EOF') && pdfBuf.length > 800,
    `${pdf.stdout}${pdf.stderr} size=${pdfBuf.length}`);
  ok('convert: pdf xref offset points at the xref table', (() => {
    const tail = pdfBuf.subarray(-120).toString('latin1');
    const at = /startxref\s+(\d+)/.exec(tail);
    return !!at && pdfBuf.subarray(Number(at[1]), Number(at[1]) + 4).toString('latin1') === 'xref';
  })());

  const docx = run([docFile, '--to', 'docx', '--quiet']);
  const docxFile = path.join(dir, 'doc.docx');
  const docxBuf = fs.existsSync(docxFile) ? fs.readFileSync(docxFile) : Buffer.alloc(0);
  ok('convert: md -> docx writes a ZIP container',
    docx.status === 0 && docxBuf.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004',
    `${docx.stdout}${docx.stderr}`);
  // Proof by Windows' own ZIP reader, not ours: if this opens, Word opens it.
  const unzip = spawnSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${docxFile.replace(/'/g, "''")}'); $names=($z.Entries|ForEach-Object{$_.FullName}) -join ','; $e=$z.GetEntry('word/document.xml'); $r=New-Object System.IO.StreamReader($e.Open(),[System.Text.Encoding]::UTF8); $xml=$r.ReadToEnd(); $r.Close(); $z.Dispose(); Write-Output $names; Write-Output ('LEN=' + $xml.Length); Write-Output ('H1=' + $xml.Contains('Heading1')); Write-Output ('AR=' + $xml.Contains([char]0x0639)); Write-Output ('BULLET=' + $xml.Contains([char]0x2022))`,
  ], { encoding: 'utf8' });
  const unzipOut = unzip.stdout || '';
  ok('convert: docx opens with the Windows ZIP reader and has the OOXML parts',
    unzipOut.includes('[Content_Types].xml') && unzipOut.includes('word/document.xml')
    && unzipOut.includes('word/styles.xml'), unzipOut.slice(0, 160) + (unzip.stderr || '').slice(0, 120));
  ok('convert: docx keeps headings, bullets and Arabic text',
    unzipOut.includes('H1=True') && unzipOut.includes('AR=True') && unzipOut.includes('BULLET=True'), unzipOut);

  const html = run([docFile, '--to', 'html', '--quiet']);
  const htmlOut = fs.readFileSync(path.join(dir, 'doc.html'), 'utf8');
  ok('convert: md -> html keeps structure and inline marks',
    html.status === 0 && htmlOut.includes('<h1>Deliverable report</h1>') && htmlOut.includes('<h2>Second section</h2>')
    && htmlOut.includes('<strong>bold</strong>') && htmlOut.includes('<ol>') && htmlOut.includes('<blockquote>'),
    htmlOut.slice(0, 200));
  ok('convert: BOM at the start does not swallow the first heading', htmlOut.includes('<h1>Deliverable report</h1>'));

  const txt = run([docFile, '--to', 'txt', '--quiet']);
  const txtOut = fs.readFileSync(path.join(dir, 'doc.txt'), 'utf8');
  ok('convert: md -> txt strips markup but keeps content',
    txt.status === 0 && txtOut.includes('Deliverable report') && txtOut.includes('numbered one')
    && !txtOut.includes('**') && !txtOut.includes('## '), JSON.stringify(txtOut.slice(0, 90)));

  // RTL detection: an Arabic-majority document must flip direction.
  const arFile = path.join(dir, 'ar.md');
  fs.writeFileSync(arFile, '# تقرير\n\nنص عربي كامل للتجربة مع جمل إضافية.\n', 'utf8');
  run([arFile, '--to', 'html', '--quiet']);
  const arHtml = fs.readFileSync(path.join(dir, 'ar.html'), 'utf8');
  ok('convert: Arabic document is rendered RTL', arHtml.includes('dir="rtl"'), arHtml.slice(0, 120));

  const warn = run([arFile, '--to', 'pdf', '--method', 'builtin']);
  ok('convert: builtin PDF warns when text cannot be represented',
    warn.status === 0 && /WARNING/.test(warn.stderr) && /browser/.test(warn.stderr), warn.stderr.slice(0, 120));

  // Batch mode over a directory.
  const batchIn = path.join(dir, 'batch');
  const batchOut = path.join(dir, 'batch-out');
  fs.mkdirSync(batchIn);
  fs.writeFileSync(path.join(batchIn, 'a.md'), '# A\n\nalpha\n');
  fs.writeFileSync(path.join(batchIn, 'b.md'), '# B\n\nbeta\n');
  fs.writeFileSync(path.join(batchIn, 'skip.png'), 'not a document');
  const batch = run([batchIn, '--to', 'html', '--out', batchOut, '--quiet']);
  const produced = fs.existsSync(batchOut) ? fs.readdirSync(batchOut) : [];
  ok('convert: directory input converts every document',
    batch.status === 0 && produced.length === 2 && produced.every((f) => f.endsWith('.html')),
    `${batch.stdout}${batch.stderr} -> ${produced.join(',')}`);

  const badFmt = run([docFile, '--to', 'rtf']);
  ok('convert: unknown format fails with the supported list',
    badFmt.status === 1 && /pdf/.test(badFmt.stderr) && /docx/.test(badFmt.stderr), badFmt.stderr.slice(0, 100));
  const missing = run([path.join(dir, 'nope.md'), '--to', 'pdf']);
  ok('convert: missing input fails cleanly', missing.status === 1 && /not found/i.test(missing.stderr), missing.stderr.slice(0, 100));
  const noBrowser = spawnSync(process.execPath, [conv, docFile, '--to', 'pdf', '--method', 'browser', '--out', path.join(dir, 'nb.pdf')],
    { encoding: 'utf8', env: { ...process.env, PATH: '', DEVIN_BROWSER: path.join(dir, 'no-such-browser.exe'), CHROME_PATH: '' } });
  const browserAvailable = fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    || fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
  ok('convert: forced browser method never falls back silently',
    browserAvailable ? noBrowser.status === 0 : (noBrowser.status === 1 && /DEVIN_BROWSER/.test(noBrowser.stderr)),
    noBrowser.stderr.slice(0, 140));

  // ---- tables + the tabular formats (xlsx / csv) ----
  const tableFile = path.join(dir, 'table.md');
  fs.writeFileSync(tableFile, [
    '# Sales',
    '',
    '| Region | Q1 | Q2 |',
    '|---|---|---|',
    '| Cairo | 1200 | 1500 |',
    '| القاهرة | 800 | 950 |',
    '',
    'Tail paragraph.',
    '',
  ].join('\n'), 'utf8');

  run([tableFile, '--to', 'html', '--quiet']);
  const tableHtml = fs.readFileSync(path.join(dir, 'table.html'), 'utf8');
  ok('convert: markdown table becomes a real HTML table',
    tableHtml.includes('<table>') && tableHtml.includes('<th>Region</th>') && tableHtml.includes('<td>1200</td>'),
    tableHtml.slice(tableHtml.indexOf('<table>'), tableHtml.indexOf('<table>') + 120));

  const xlsx = run([tableFile, '--to', 'xlsx', '--quiet']);
  const xlsxFile = path.join(dir, 'table.xlsx');
  ok('convert: md -> xlsx writes a ZIP container',
    xlsx.status === 0 && fs.readFileSync(xlsxFile).subarray(0, 4).toString('latin1') === 'PK\u0003\u0004',
    `${xlsx.stdout}${xlsx.stderr}`);
  const xlsxProbe = spawnSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${xlsxFile.replace(/'/g, "''")}'); $names=($z.Entries|ForEach-Object{$_.FullName}) -join ','; $e=$z.GetEntry('xl/worksheets/sheet1.xml'); $r=New-Object System.IO.StreamReader($e.Open(),[System.Text.Encoding]::UTF8); $xml=$r.ReadToEnd(); $r.Close(); $z.Dispose(); Write-Output $names; Write-Output ('NUM=' + $xml.Contains('<v>1200</v>')); Write-Output ('HEAD=' + $xml.Contains('Region')); Write-Output ('AR=' + $xml.Contains([char]0x0642))`,
  ], { encoding: 'utf8' });
  const xlsxOut = xlsxProbe.stdout || '';
  ok('convert: xlsx opens with the Windows ZIP reader and has the workbook parts',
    xlsxOut.includes('xl/workbook.xml') && xlsxOut.includes('xl/worksheets/sheet1.xml') && xlsxOut.includes('xl/styles.xml'),
    xlsxOut.slice(0, 160) + (xlsxProbe.stderr || '').slice(0, 120));
  ok('convert: xlsx keeps numbers numeric, headers and Arabic cells',
    xlsxOut.includes('NUM=True') && xlsxOut.includes('HEAD=True') && xlsxOut.includes('AR=True'), xlsxOut);

  run([tableFile, '--to', 'csv', '--quiet']);
  const csvOut = fs.readFileSync(path.join(dir, 'table.csv'), 'utf8');
  ok('convert: md -> csv holds the table rows',
    csvOut.startsWith('\uFEFF') && csvOut.includes('Region,Q1,Q2') && csvOut.includes('Cairo,1200,1500'),
    JSON.stringify(csvOut.slice(0, 60)));

  // A document with no table still exports to csv (type + text rows).
  run([docFile, '--to', 'csv', '--out', path.join(dir, 'notable.csv'), '--quiet']);
  const noTableCsv = fs.readFileSync(path.join(dir, 'notable.csv'), 'utf8');
  ok('convert: tableless document still exports rows to csv',
    noTableCsv.includes('type,text') && noTableCsv.includes('Deliverable report'), JSON.stringify(noTableCsv.slice(0, 70)));

  run([tableFile, '--to', 'json', '--quiet']);
  const jsonOut = JSON.parse(fs.readFileSync(path.join(dir, 'table.json'), 'utf8'));
  ok('convert: json carries blocks and tables',
    Array.isArray(jsonOut.blocks) && jsonOut.blocks.some((b) => b.type === 'table')
    && Array.isArray(jsonOut.tables) && jsonOut.tables[0][0][0] === 'Region', JSON.stringify(jsonOut).slice(0, 120));

  run([tableFile, '--to', 'md', '--out', path.join(dir, 'round.md'), '--quiet']);
  const roundMd = fs.readFileSync(path.join(dir, 'round.md'), 'utf8');
  ok('convert: md output round-trips headings and tables',
    roundMd.includes('# Sales') && roundMd.includes('| Region | Q1 | Q2 |') && roundMd.includes('|---|---|---|'),
    JSON.stringify(roundMd.slice(0, 80)));

  const overwrite = run([tableFile, '--to', 'md']);
  ok('convert: refuses to overwrite its own input',
    overwrite.status === 1 && /refusing to overwrite/i.test(overwrite.stderr), overwrite.stderr.slice(0, 100));

  const formats = run(['--formats']);
  const listed = formats.stdout.trim().split(/\r?\n/);
  ok('convert: --formats prints the registry ids',
    formats.status === 0 && ['pdf', 'docx', 'xlsx', 'csv', 'html', 'txt', 'md', 'json'].every((f) => listed.includes(f)),
    formats.stdout.trim());

  // Only node builtins may be imported by the new scripts.
  const libFiles = [conv, ...fs.readdirSync(path.join(WORKBENCH, 'scripts', 'lib')).map((f) => path.join(WORKBENCH, 'scripts', 'lib', f))];
  const badImports = [];
  for (const file of libFiles) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
      if (!m[1].startsWith('node:') && !m[1].startsWith('./') && !m[1].startsWith('../')) badImports.push(`${path.basename(file)}: ${m[1]}`);
    }
  }
  ok('convert: zero external dependencies', badImports.length === 0, badImports.join(', '));

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
