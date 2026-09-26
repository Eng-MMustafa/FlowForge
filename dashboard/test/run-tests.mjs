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

// The persisted auth-verdict store must point at a temp file for the WHOLE run:
// sticky-auth checks write to it, and it must never touch the real file.
const AUTH_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-authstore-'));
process.env.FF_PROVIDER_AUTH_STORE = path.join(AUTH_STORE_DIR, 'auth.json');

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

// Instructions ship as text the agent literally runs: a `%APPDATA%` locator or
// a `WORKBENCH\dir` backslash path is silently wrong on Linux/macOS, so the
// skills must name the per-OS locations and use forward slashes (valid on
// Windows too).
{
  const offenders = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/%APPDATA%\\devin\\flowforge\.json/.test(src)) offenders.push(`${path.relative(WORKBENCH, p)}: %APPDATA% locator`);
      if (/(?:WORKBENCH|PROJECT|project)>?\\/.test(src)) offenders.push(`${path.relative(WORKBENCH, p)}: backslash path`);
    }
  };
  scan(path.join(WORKBENCH, 'skills'));
  scan(path.join(WORKBENCH, 'agents'));
  ok('portability: skills and agents use platform-neutral paths', offenders.length === 0, offenders.join(' | '));
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
  const sdb = {};
  for (const p of P.PLATFORMS) sdb[p] = P.agentSessionsDbCandidates(p, envs[p], homes[p]).map((c) => c.replace(/\\/g, '/'));
  ok('platform: every OS knows where Devin keeps its session log',
    P.PLATFORMS.every((p) => sdb[p].length > 0 && sdb[p].every((c) => c.endsWith('devin/cli/sessions.db')))
    && sdb.win32[0].includes('AppData/Roaming/devin') && sdb.darwin[0].includes('Application Support/devin')
    && sdb.linux.some((c) => c.includes('.local/share/devin')), JSON.stringify(sdb));

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

  // Killing a process tree and the git null device are OS details too: a bare
  // taskkill spawn or a hard-coded 'NUL' silently does nothing on POSIX.
  const srv = fs.readFileSync(path.join(WORKBENCH, 'dashboard', 'server.mjs'), 'utf8');
  ok('platform: server never spawns Windows tools directly',
    !/execFile\('taskkill'/.test(srv) && !/['"]NUL['"]/.test(srv));
  ok('platform: git --no-index diffs use the OS null device',
    srv.includes('os.devNull'));
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
  // GNU tar cannot read zip archives and minimal Linux installs ship neither
  // bsdtar nor unzip - the installer needs the python3 zipfile fallback.
  ok('get.mjs: survives a Linux box with only GNU tar (bsdtar/unzip/python3 fallbacks)',
    /bsdtar/.test(src) && /python3/.test(src));
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
  const presets = ['task', 'understand', 'quality', 'fast', 'cheap', 'bugfix', 'tests', 'design', 'analytics', 'perf',
    'review', 'refactor', 'deps', 'automate', 'data', 'security', 'secfix', 'ai-feature'];
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
  ok('agents: analytics, performance and security roles exist',
    agentNames.includes('researcher') && agentNames.includes('optimizer') && agentNames.includes('security'),
    agentNames.join(','));
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
    presets.every((name) => {
      const flow = JSON.parse(fs.readFileSync(path.join(WORKBENCH, 'flows', name + '.json'), 'utf8'));
      return flow.stages.filter((s) => s.agent).every((s) => typeof s.model === 'string' && s.model.length);
    }));

  // The schema contract every shipped preset follows. Only presets are checked,
  // so a flow a user writes into flows/ can never break the suite.
  const readPreset = (name) => JSON.parse(fs.readFileSync(path.join(WORKBENCH, 'flows', name + '.json'), 'utf8'));
  const isText = (v) => typeof v === 'string' && v.trim().length > 0;
  const contractProblems = [];
  for (const name of presets) {
    const flow = readPreset(name);
    const bad = (msg) => contractProblems.push(name + ': ' + msg);
    if (flow.name !== name) bad('name does not match the file name');
    for (const k of ['title', 'titleAr', 'description']) if (!isText(flow[k])) bad('missing ' + k);
    if (!['auto', 'terminal', 'dashboard'].includes(flow.defaultGate)) bad('bad defaultGate');
    for (const s of flow.stages) {
      const where = s.id + ': ';
      if (!isText(s.title)) bad(where + 'missing title');
      if (!(Array.isArray(s.done) && s.done.length && s.done.every(isText))) bad(where + 'done[] must be non-empty strings');
      if (s.agent && !(typeof s.prompt === 'string' && s.prompt.includes('{PROJECT}'))) bad(where + 'prompt lacks {PROJECT}');
      if (s.gate && s.gate !== 'auto' && !(isText(s.gateQuestion) && isText(s.gateQuestionAr))) bad(where + 'gate without bilingual question');
      if (s.onFail) {
        if (!(Number.isInteger(s.maxLoops) && s.maxLoops >= 1 && s.maxLoops <= 5)) bad(where + 'maxLoops must be an integer 1-5');
        if (!(/VERDICT: PASS/.test(s.prompt || '') && /VERDICT: FAIL/.test(s.prompt || ''))) bad(where + 'onFail stage prompt lacks VERDICT: PASS/FAIL');
      }
      if (s.runOnlyWhenJumpedTo && !(s.next && flow.stages.some((o) => o.onFail === s.id))) {
        bad(where + 'jump-only stage needs next and an onFail pointing at it');
      }
    }
  }
  ok('flows: presets follow the schema contract', contractProblems.length === 0, contractProblems.join(' | '));
  const noLoop = presets.filter((name) => name !== 'understand' && !readPreset(name).stages.some((s) => s.onFail));
  ok('flows: every preset except understand has a failure loop', noLoop.length === 0, noLoop.join(','));
  const writers = [];
  for (const name of ['analytics', 'design', 'review', 'data', 'security']) {
    for (const s of readPreset(name).stages) {
      if (['coder', 'debugger', 'shipper'].includes(s.agent)) writers.push(name + '/' + s.id + ': ' + s.agent);
    }
  }
  ok('flows: read-only presets never modify code', writers.length === 0, writers.join(' | '));
  {
    const flow = readPreset('analytics');
    const ids = flow.stages.map((s) => s.id);
    const by = Object.fromEntries(flow.stages.map((s) => [s.id, s]));
    const order = ['measure', 'verify', 'interpret', 'validate'].map((id) => ids.indexOf(id));
    ok('flows: analytics verifies numbers before interpreting them',
      order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]))
      && by.verify?.onFail === 'measure' && by.validate?.onFail === 'interpret'
      && flow.stages[flow.stages.length - 1].gate !== 'auto'
      && (by.measure?.done || []).some((d) => /command/i.test(d))
      && (by.interpret?.done || []).some((d) => /first concrete step/i.test(d)),
      ids.join(','));
  }
  {
    const src = fs.readFileSync(path.join(WORKBENCH, 'agents', 'security.md'), 'utf8');
    const phrases = ['Defensive only', 'Read-only on product code', 'NOT AVAILABLE', 'redact'];
    ok('agents: security role is defensive and read-only', phrases.every((p) => src.includes(p)),
      phrases.filter((p) => !src.includes(p)).join(','));
  }

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
  ok('providers: all sixteen ids exported',
    JSON.stringify(P.PROVIDER_IDS) === JSON.stringify(
      ['devin', 'copilot', 'cursor', 'trae', 'windsurf', 'claude', 'codex', 'gemini',
        'zed', 'kiro', 'antigravity', 'aider', 'opencode', 'auggie', 'cline', 'continue']),
    JSON.stringify(P.PROVIDER_IDS));
  ok('providers: every descriptor is bilingual with a model catalogue',
    P.PROVIDER_IDS.every((id) => P.PROVIDERS[id].label && P.PROVIDERS[id].labelAr
      && P.providerModels(id).length && P.providerModels(id).every((f) => f.slug && f.label
        && Array.isArray(f.aliases) && Array.isArray(f.variants))));
  ok('providers: only devin is runnable',
    P.PROVIDERS.devin.runnable === true
    && P.PROVIDER_IDS.filter((id) => id !== 'devin').every((id) => !P.PROVIDERS[id].runnable));

  // No machine path may be hard-coded: every root comes from the environment.
  const provSrc = fs.readFileSync(path.join(DASHBOARD, 'providers.mjs'), 'utf8');
  ok('providers: registry carries no machine-specific path',
    !/[A-Za-z]:\\+(Users|New folder)/.test(provSrc));
  ok('providers: zero external dependencies',
    [...provSrc.matchAll(/from\s+'([^']+)'/g)].every((m) => m[1].startsWith('node:') || m[1].startsWith('./') || m[1].startsWith('../')));

  // Login layer: only a CLI-owned login may offer a button; an editor-owned
  // sign-in must explain itself bilingually instead of faking one.
  ok('providers: cli-owned logins are declared as such',
    ['devin', 'copilot', 'claude', 'codex', 'gemini', 'opencode', 'auggie']
      .every((id) => P.providerAuthKind(id) === 'cli'));
  ok('providers: app-signed tools declare an in-app sign-in with a bilingual reason',
    ['cursor', 'trae', 'windsurf', 'zed', 'kiro', 'antigravity']
      .every((id) => P.providerAuthKind(id) === 'app'
        && P.PROVIDERS[id].auth.reason && P.PROVIDERS[id].auth.reasonAr));
  ok('providers: extension/key-driven tools declare kind none with a bilingual reason',
    ['aider', 'cline', 'continue'].every((id) => P.providerAuthKind(id) === 'none'
      && P.PROVIDERS[id].auth.reason && P.PROVIDERS[id].auth.reasonAr));
  ok('providers: in-app sign-in yields no login script',
    ['cursor', 'trae', 'windsurf', 'zed', 'kiro', 'antigravity']
      .every((id) => P.providerLoginScript(id, 'C:\\any\\cli.exe') === null));
  // With every probe pointed at a bogus home, there is genuinely no CLI to
  // log in through - and the script builder must say so instead of spawning
  // a terminal on a path that cannot exist.
  process.env.FF_PROVIDER_HOME_CODEX = path.join(os.tmpdir(), 'ff-no-codex-here');
  ok('providers: no login script without a CLI path',
    P.providerLoginScript('codex', '') === null);
  delete process.env.FF_PROVIDER_HOME_CODEX;
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
  // Sticky for the app kind too: a half-rewritten editor store keeps the
  // verified verdict instead of nagging for a login that already happened.
  writeStore({ 'iCubeAuthInfo://icube.cloudide': SECRET });
  P.invalidateProviderAuth();
  await P.checkProviderAuth('trae', await P.detectProvider('trae', null), true);
  fs.writeFileSync(path.join(traeStore, 'storage.json'), '{');
  P.invalidateProviderAuth();
  const traeStale = await P.checkProviderAuth('trae', await P.detectProvider('trae', null), true);
  ok('providers: a half-written editor store keeps the verified login (stale)',
    traeStale.known === false && traeStale.loggedIn === true && traeStale.stale === true,
    JSON.stringify({ k: traeStale.known, l: traeStale.loggedIn, s: traeStale.stale }));
  fs.rmSync(path.join(traeStore, 'storage.json'));
  P.invalidateProviderAuth();
  const traeGone = await P.checkProviderAuth('trae', await P.detectProvider('trae', null), true);
  ok('providers: a deleted editor store never resurrects a login',
    traeGone.known === false && traeGone.loggedIn === false && traeGone.stale === false);
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

  // Cursor's real token lives in a SQLite store we will not parse, but the
  // cursor-agent CLI keeps a readable ~/.config/cursor/auth.json - the same
  // account, so it counts as a signed-in Cursor.
  const curHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cursor-'));
  fs.mkdirSync(path.join(curHome, '.config', 'cursor'), { recursive: true });
  fs.writeFileSync(path.join(curHome, '.config', 'cursor', 'auth.json'),
    JSON.stringify({ accessToken: 'cur_' + 'c'.repeat(80) }));
  process.env.FF_PROVIDER_HOME_CURSOR = curHome;
  P.invalidateProviderAuth();
  const curIn = await P.checkProviderAuth('cursor', await P.detectProvider('cursor', null), true);
  ok('providers: cursor-agent auth.json reads as a signed-in Cursor',
    curIn.known === true && curIn.loggedIn === true
    && !JSON.stringify(curIn).includes('c'.repeat(40)),
    JSON.stringify({ k: curIn.known, l: curIn.loggedIn }));
  delete process.env.FF_PROVIDER_HOME_CURSOR;
  P.invalidateProviderAuth();

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

  // CLI-first providers: the config home counts as the editor surface, and the
  // bundled binary under it counts as the CLI - no PATH lookup needed.
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-claude-'));
  fs.mkdirSync(path.join(claudeHome, '.claude', 'local'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, '.claude', 'local', 'claude'), '#!/bin/sh\n');
  process.env.FF_PROVIDER_HOME_CLAUDE = claudeHome;
  const detClaude = await P.detectProvider('claude', null);
  const claudeScript = P.providerLoginScript('claude', '');
  ok('providers: claude config home and bundled CLI are detected',
    detClaude.installed === true && /local/.test(detClaude.cliPath || ''),
    JSON.stringify({ e: detClaude.editorPath, c: detClaude.cliPath }));
  ok('providers: claude login script runs auth login then auth status',
    !!claudeScript && claudeScript.lines.some((l) => l.includes('"auth" "login"'))
    && claudeScript.lines.some((l) => l.includes('"auth" "status"')),
    JSON.stringify(claudeScript && claudeScript.lines));

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-codex-'));
  fs.mkdirSync(path.join(codexHome, '.codex', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, '.codex', 'bin', 'codex'), '#!/bin/sh\n');
  process.env.FF_PROVIDER_HOME_CODEX = codexHome;
  const detCodex = await P.detectProvider('codex', null);
  const codexScript = P.providerLoginScript('codex', '');
  ok('providers: codex config home and bundled CLI are detected',
    detCodex.installed === true && /bin/.test(detCodex.cliPath || ''),
    JSON.stringify({ e: detCodex.editorPath, c: detCodex.cliPath }));
  ok('providers: codex login script runs `login` then `login status`',
    !!codexScript && codexScript.lines.some((l) => l.includes('"login" "status"')),
    JSON.stringify(codexScript && codexScript.lines));

  // Gemini answers auth from its OAuth creds file, not from a status command.
  const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-gemini-'));
  fs.mkdirSync(path.join(geminiHome, '.gemini', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(geminiHome, '.gemini', 'bin', 'gemini'), '#!/bin/sh\n');
  const geminiCreds = path.join(geminiHome, '.gemini', 'oauth_creds.json');
  const GSECRET = 'ya29.' + 'x'.repeat(120);
  process.env.FF_PROVIDER_HOME_GEMINI = geminiHome;
  fs.writeFileSync(geminiCreds, JSON.stringify({ access_token: GSECRET }));
  const detGemini = await P.detectProvider('gemini', null);
  P.invalidateProviderAuth();
  const geminiIn = await P.checkProviderAuth('gemini', detGemini, true);
  ok('providers: gemini OAuth creds file reads as signed in',
    geminiIn.kind === 'cli' && geminiIn.canLogin === true && geminiIn.known === true
    && geminiIn.loggedIn === true, JSON.stringify(geminiIn).slice(0, 160));
  ok('providers: the gemini token never leaves the reader',
    !JSON.stringify(geminiIn).includes(GSECRET) && !JSON.stringify(geminiIn).includes('x'.repeat(40)));
  fs.writeFileSync(geminiCreds, '{}');
  P.invalidateProviderAuth();
  const geminiOut = await P.checkProviderAuth('gemini', await P.detectProvider('gemini', null), true);
  ok('providers: emptied gemini creds read as signed out, not unknown',
    geminiOut.known === true && geminiOut.loggedIn === false, JSON.stringify(geminiOut.detail));
  fs.rmSync(geminiCreds);
  P.invalidateProviderAuth();
  const geminiUnknown = await P.checkProviderAuth('gemini', await P.detectProvider('gemini', null), true);
  ok('providers: no gemini creds -> unknown, never a confident "logged out"',
    geminiUnknown.known === false && geminiUnknown.loggedIn === false && geminiUnknown.canLogin === true);
  // Sticky for the session-file kind: a verified login survives a creds file
  // that is momentarily corrupt (mid-rewrite by the tool), but a missing file
  // never resurrects a verdict.
  fs.writeFileSync(geminiCreds, JSON.stringify({ access_token: GSECRET }));
  P.invalidateProviderAuth();
  await P.checkProviderAuth('gemini', await P.detectProvider('gemini', null), true);
  fs.writeFileSync(geminiCreds, '{');
  P.invalidateProviderAuth();
  const geminiStale = await P.checkProviderAuth('gemini', await P.detectProvider('gemini', null), true);
  ok('providers: a half-written creds file keeps the verified login (stale)',
    geminiStale.known === false && geminiStale.loggedIn === true && geminiStale.stale === true,
    JSON.stringify({ k: geminiStale.known, l: geminiStale.loggedIn, s: geminiStale.stale }));
  fs.rmSync(geminiCreds);
  P.invalidateProviderAuth();
  const geminiGone = await P.checkProviderAuth('gemini', await P.detectProvider('gemini', null), true);
  ok('providers: a deleted creds file never resurrects a login',
    geminiGone.known === false && geminiGone.loggedIn === false && geminiGone.stale === false,
    JSON.stringify({ k: geminiGone.known, l: geminiGone.loggedIn }));
  const geminiScript = P.providerLoginScript('gemini', '');
  ok('providers: gemini login opens the tool itself and verifies with --version',
    !!geminiScript && geminiScript.lines.some((l) => l.includes('"--version"')),
    JSON.stringify(geminiScript && geminiScript.lines));
  delete process.env.FF_PROVIDER_HOME_CLAUDE;
  delete process.env.FF_PROVIDER_HOME_CODEX;
  delete process.env.FF_PROVIDER_HOME_GEMINI;
  P.invalidateProviderAuth();

  // OpenCode: auth.json is keyed per connected account - any key counts as a
  // login, and the token payload never leaves the reader.
  const ocHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-oc-'));
  fs.mkdirSync(path.join(ocHome, '.local', 'share', 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(ocHome, '.opencode', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(ocHome, '.opencode', 'bin', 'opencode'), '#!/bin/sh\n');
  process.env.FF_PROVIDER_HOME_OPENCODE = ocHome;
  fs.writeFileSync(path.join(ocHome, '.local', 'share', 'opencode', 'auth.json'),
    JSON.stringify({ anthropic: { key: 'sk-' + 'k'.repeat(60) } }));
  P.invalidateProviderAuth();
  const ocIn = await P.checkProviderAuth('opencode', await P.detectProvider('opencode', null), true);
  ok('providers: opencode auth.json reads as signed in without a CLI probe',
    ocIn.kind === 'cli' && ocIn.known === true && ocIn.loggedIn === true
    && !JSON.stringify(ocIn).includes('k'.repeat(30)),
    JSON.stringify({ k: ocIn.known, l: ocIn.loggedIn }));
  fs.writeFileSync(path.join(ocHome, '.local', 'share', 'opencode', 'auth.json'), '{}');
  P.invalidateProviderAuth();
  const ocOut = await P.checkProviderAuth('opencode', await P.detectProvider('opencode', null), true);
  ok('providers: emptied opencode auth.json reads as signed out',
    ocOut.known === true && ocOut.loggedIn === false);
  delete process.env.FF_PROVIDER_HOME_OPENCODE;
  P.invalidateProviderAuth();

  // Augment: session.json under ~/.augment is the readable login.
  const augHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-aug-'));
  fs.mkdirSync(path.join(augHome, '.augment', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(augHome, '.augment', 'bin', 'auggie'), '#!/bin/sh\n');
  process.env.FF_PROVIDER_HOME_AUGGIE = augHome;
  fs.writeFileSync(path.join(augHome, '.augment', 'session.json'),
    JSON.stringify({ accessToken: 'at_' + 't'.repeat(60) }));
  P.invalidateProviderAuth();
  const augIn = await P.checkProviderAuth('auggie', await P.detectProvider('auggie', null), true);
  ok('providers: augment session.json reads as signed in, token stays inside',
    augIn.known === true && augIn.loggedIn === true
    && !JSON.stringify(augIn).includes('t'.repeat(30)),
    JSON.stringify({ k: augIn.known, l: augIn.loggedIn }));
  delete process.env.FF_PROVIDER_HOME_AUGGIE;
  P.invalidateProviderAuth();

  // Sticky "keep me signed in": once `auth status` verifies a login, a probe
  // that crashes or times out WITHOUT a denial marker must keep the connected
  // verdict - only the provider's own "not logged in" may clear it. The fake
  // CLI is a real script the OS can run; the store is redirected to a temp file.
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-store-'));
  process.env.FF_PROVIDER_AUTH_STORE = path.join(storeDir, 'auth.json');
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-fakecli-'));
  const onWin = process.platform === 'win32';
  const fakeCli = path.join(fakeDir, onWin ? 'devin-x.cmd' : 'devin-x.sh');
  const fixCli = (body) => {
    fs.writeFileSync(fakeCli, body);
    if (!onWin) fs.chmodSync(fakeCli, 0o755);
  };
  fixCli(onWin ? '@echo off\r\necho Logged in (via Devin).\r\n' : '#!/bin/sh\necho "Logged in (via Devin)."\n');
  process.env.DEVIN_CLI = fakeCli;
  const stickyIn = await P.checkProviderAuth('devin', { installed: true }, true);
  P.invalidateProviderAuth();
  fixCli(onWin ? '@exit /b 42\r\n' : '#!/bin/sh\nexit 42\n');
  const stickyStale = await P.checkProviderAuth('devin', { installed: true }, true);
  P.invalidateProviderAuth();
  fixCli(onWin ? '@echo off\r\necho You are not logged in\r\n' : '#!/bin/sh\necho "You are not logged in"\n');
  // Point the roots at a fake home that has a credentials.toml on every OS: a
  // stored credential that the provider now rejects is an EXPIRED session,
  // not a never-logged-in machine.
  const kept = {};
  for (const k of ['APPDATA', 'XDG_CONFIG_HOME', 'USERPROFILE', 'HOME']) {
    kept[k] = process.env[k]; process.env[k] = fakeDir;
  }
  fs.mkdirSync(path.join(fakeDir, 'devin'), { recursive: true });
  fs.writeFileSync(path.join(fakeDir, 'devin', 'credentials.toml'), 'windsurf_api_key="x"');
  fs.mkdirSync(path.join(fakeDir, 'Library', 'Application Support', 'devin'), { recursive: true });
  fs.writeFileSync(path.join(fakeDir, 'Library', 'Application Support', 'devin', 'credentials.toml'), 'windsurf_api_key="x"');
  const stickyOut = await P.checkProviderAuth('devin', { installed: true }, true);
  for (const k of Object.keys(kept)) {
    if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k];
  }
  delete process.env.DEVIN_CLI;
  delete process.env.FF_PROVIDER_AUTH_STORE;
  P.invalidateProviderAuth();
  ok('providers: a verified login is recorded',
    stickyIn.loggedIn === true && stickyIn.stale === false, JSON.stringify(stickyIn).slice(0, 160));
  ok('providers: a crashed probe keeps the verified login (stale), never nags',
    stickyStale.loggedIn === true && stickyStale.stale === true, JSON.stringify(stickyStale).slice(0, 160));
  ok('providers: an explicit "not logged in" clears the sticky verdict',
    stickyOut.loggedIn === false && stickyOut.stale === false, JSON.stringify(stickyOut).slice(0, 160));
  ok('providers: a rejected stored credential reads as expired, and offers the token login',
    stickyOut.expired === true && stickyOut.altLogin === true,
    JSON.stringify({ e: stickyOut.expired, a: stickyOut.altLogin }));
  // The token login is a real second script: manual-token flow then a verify.
  process.env.DEVIN_CLI = fakeCli;
  const devinScript = P.providerLoginScript('devin', '');
  delete process.env.DEVIN_CLI;
  ok('providers: the token login script runs --force-manual-token-flow then verifies',
    !!devinScript && !!devinScript.alt
    && devinScript.alt.lines.some((l) => l.includes('"--force-manual-token-flow"'))
    && devinScript.alt.lines.some((l) => l.includes('"auth" "status"')),
    JSON.stringify(devinScript && devinScript.alt && devinScript.alt.lines));

  // Self-heal against the shared-file clobber: the credentials file is written
  // by a sibling app that keeps replacing it. The fake CLI is cred-aware - it
  // only accepts the GOODKEY - so when the file is overwritten, the first probe
  // denies, the verified snapshot is restored, and the re-check passes.
  const healDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-heal-'));
  process.env.FF_PROVIDER_AUTH_STORE = path.join(healDir, 'auth.json');
  const healBase = process.platform === 'darwin'
    ? path.join(healDir, 'Library', 'Application Support') : healDir;
  fs.mkdirSync(path.join(healBase, 'devin'), { recursive: true });
  const credFile = path.join(healBase, 'devin', 'credentials.toml');
  fs.writeFileSync(credFile, 'windsurf_api_key="GOODKEY"');
  const healCli = path.join(healDir, onWin ? 'devin-h.cmd' : 'devin-h.sh');
  const fixCli2 = (p, body) => {
    fs.writeFileSync(p, body);
    if (!onWin) fs.chmodSync(p, 0o755);
  };
  fixCli2(healCli, onWin
    ? `@echo off\r\nfindstr /C:"GOODKEY" "${credFile}" >nul && echo Logged in (via Devin). || echo You are not logged in\r\n`
    : `#!/bin/sh\ngrep -q GOODKEY "${credFile}" && echo "Logged in (via Devin)." || echo "You are not logged in"\n`);
  process.env.DEVIN_CLI = healCli;
  for (const k of ['APPDATA', 'XDG_CONFIG_HOME', 'USERPROFILE', 'HOME']) {
    kept[k] = process.env[k]; process.env[k] = healDir;
  }
  const healVerified = await P.checkProviderAuth('devin', { installed: true }, true);
  // The sibling app overwrites the credentials mid-session.
  fs.writeFileSync(credFile, 'windsurf_api_key="BADKEY"');
  P.invalidateProviderAuth();
  const healRestored = await P.checkProviderAuth('devin', { installed: true }, true);
  // An explicit logout empties the file - that must never resurrect a session.
  fs.writeFileSync(credFile, '');
  P.invalidateProviderAuth();
  const healLogout = await P.checkProviderAuth('devin', { installed: true }, true);
  for (const k of Object.keys(kept)) {
    if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k];
  }
  delete process.env.DEVIN_CLI;
  delete process.env.FF_PROVIDER_AUTH_STORE;
  P.invalidateProviderAuth();
  ok('providers: a verified login snapshots its credentials',
    healVerified.loggedIn === true, JSON.stringify(healVerified).slice(0, 120));
  ok('providers: an overwritten credentials file is self-healed',
    healRestored.loggedIn === true && healRestored.healed === true,
    JSON.stringify({ l: healRestored.loggedIn, h: healRestored.healed, d: healRestored.detail }));
  ok('providers: an emptied credential file is a real logout, not resurrected',
    healLogout.loggedIn === false && healLogout.healed === false
    && healLogout.expired === false, JSON.stringify(healLogout).slice(0, 120));

  // Extension/key-driven tools never offer a login or open button.
  const noAider = await P.checkProviderAuth('aider', { cliPath: null, editorPath: null }, true);
  const noCline = await P.checkProviderAuth('cline', { cliPath: null, editorPath: null }, true);
  ok('providers: kind none offers no login, no open, no false status',
    noAider.kind === 'none' && noAider.canLogin === false && noAider.canOpen === false
    && noCline.kind === 'none' && noCline.canLogin === false,
    JSON.stringify(noAider));
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
  write(['CLAUDE.md'], '# claude instructions');
  write(['.claude', 'agents', 'reviewer.md'], '# reviewer');
  write(['.mcp.json'], '{"mcpServers":{}}');
  write(['GEMINI.md'], '# gemini instructions');
  write(['.gemini', 'settings.json'], '{}');
  write(['.windsurf', 'rules', 'team.md'], '# windsurf rule');
  write(['AGENTS.md'], '# agents');
  write(['.kiro', 'steering', 'product.md'], '# steering');
  write(['.aiderignore'], 'dist/');
  write(['CONVENTIONS.md'], '# conventions');
  write(['opencode.json'], '{}');
  write(['.roo', 'rules', 'style.md'], '# roo rule');
  write(['.continuerules'], '# continue rule');
  write(['.agents', 'rules', 'ag.md'], '# antigravity rule');
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
  const detClaudeWs = await P.detectProvider('claude', modProj);
  const detGeminiWs = await P.detectProvider('gemini', modProj);
  const detWindsurfWs = await P.detectProvider('windsurf', modProj);
  const detCodexWs = await P.detectProvider('codex', modProj);
  ok('providers: claude workspace modules found',
    detClaudeWs.modules.some((m) => m.label === 'CLAUDE.md' && m.kind === 'instruction')
    && detClaudeWs.modules.some((m) => m.label === '.claude/agents/reviewer.md' && m.kind === 'agent')
    && detClaudeWs.modules.some((m) => m.label === '.mcp.json' && m.kind === 'mcp'),
    JSON.stringify(detClaudeWs.modules.map((m) => m.label)));
  ok('providers: gemini workspace modules found',
    detGeminiWs.modules.some((m) => m.label === 'GEMINI.md')
    && detGeminiWs.modules.some((m) => m.label === '.gemini/settings.json'),
    JSON.stringify(detGeminiWs.modules.map((m) => m.label)));
  ok('providers: windsurf workspace rules found',
    detWindsurfWs.modules.some((m) => m.label === '.windsurf/rules/team.md' && m.kind === 'rule'),
    JSON.stringify(detWindsurfWs.modules.map((m) => m.label)));
  ok('providers: codex workspace modules found',
    detCodexWs.modules.some((m) => m.label === 'AGENTS.md' && m.kind === 'instruction'),
    JSON.stringify(detCodexWs.modules.map((m) => m.label)));
  const detKiroWs = await P.detectProvider('kiro', modProj);
  const detAiderWs = await P.detectProvider('aider', modProj);
  const detOcWs = await P.detectProvider('opencode', modProj);
  const detClineWs = await P.detectProvider('cline', modProj);
  const detContWs = await P.detectProvider('continue', modProj);
  const detAgWs = await P.detectProvider('antigravity', modProj);
  const detZedWs = await P.detectProvider('zed', modProj);
  ok('providers: kiro steering + AGENTS.md found',
    detKiroWs.modules.some((m) => m.label === '.kiro/steering/product.md' && m.kind === 'rule')
    && detKiroWs.modules.some((m) => m.label === 'AGENTS.md'),
    JSON.stringify(detKiroWs.modules.map((m) => m.label)));
  ok('providers: aider config files found',
    detAiderWs.modules.some((m) => m.label === '.aiderignore')
    && detAiderWs.modules.some((m) => m.label === 'CONVENTIONS.md')
    && detAiderWs.modules.some((m) => m.label === 'AGENTS.md'),
    JSON.stringify(detAiderWs.modules.map((m) => m.label)));
  ok('providers: opencode workspace config found',
    detOcWs.modules.some((m) => m.label === 'opencode.json')
    && detOcWs.modules.some((m) => m.label === 'AGENTS.md'),
    JSON.stringify(detOcWs.modules.map((m) => m.label)));
  ok('providers: roo rules found under cline',
    detClineWs.modules.some((m) => m.label === '.roo/rules/style.md')
    && detClineWs.modules.some((m) => m.label === 'AGENTS.md'),
    JSON.stringify(detClineWs.modules.map((m) => m.label)));
  ok('providers: continue rules found',
    detContWs.modules.some((m) => m.label === '.continuerules')
    && detContWs.modules.some((m) => m.label === 'AGENTS.md'),
    JSON.stringify(detContWs.modules.map((m) => m.label)));
  ok('providers: antigravity .agents rules found',
    detAgWs.modules.some((m) => m.label === '.agents/rules/ag.md')
    && detAgWs.modules.some((m) => m.label === 'AGENTS.md'),
    JSON.stringify(detAgWs.modules.map((m) => m.label)));
  ok('providers: zed sees AGENTS.md',
    detZedWs.modules.some((m) => m.label === 'AGENTS.md' && m.kind === 'rule'),
    JSON.stringify(detZedWs.modules.map((m) => m.label)));

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

// ---------- usage: token estimator + Devin's session log ----------
console.log('# usage checks');
// A fixture shaped exactly like Devin's sessions.db: a system-prefix node, a
// compaction copy of a call (same request_id twice), flow / refine / chat
// sessions, and one session in the previous month. Built only where
// node:sqlite exists (Node 22.13+); elsewhere the log must report itself
// unavailable instead of failing.
let HAS_SQLITE = false;
let sqliteLib = null;
try { sqliteLib = await import('node:sqlite'); HAS_SQLITE = !!sqliteLib.DatabaseSync; } catch { HAS_SQLITE = false; }
const usageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-usage-'));
const usageDb = path.join(usageDir, 'sessions.db');
const usageRunsFile = path.join(usageDir, 'runs.json');
// A price list shaped like Devin's models page (`modelCostData = [...]`),
// with prices chosen so every fixture call costs exactly 2x its ACU - the
// dollar rate must be MEASURED from it, not assumed.
const usagePrices = path.join(usageDir, 'models.md');
const priceRow = (tier, id, p) => ({
  tier, model_uid: id, label: id, model_provider: 'X',
  input_cost_per_million_usd: p[0], output_cost_per_million_usd: p[1],
  cache_write_cost_per_million_usd: p[2], cache_read_cost_per_million_usd: p[3], credit_multiplier: 1,
});
const PRICE_ROWS = [
  ['claude-opus-5-5-xhigh', [500, 0, 0, 100]], ['swe-2-medium', [500, 1000, 0, 0]], ['kimi-k2-7', [0, 200, 0, 191]],
  ['claude-opus-5-high', [5, 25, 6.25, 0.5]], ['claude-sonnet-5-high', [2, 10, 2.5, 0.2]], ['swe-1-7', [0.5, 2.5, 0, 0.2]],
];
const priceText = (scale = 1) => `# AI Models\n\nexport const modelCostData = ${JSON.stringify([
  ...PRICE_ROWS.map(([id, p]) => priceRow('TEAMS_TIER_ENTERPRISE_SAAS', id, p.map((v) => v * scale))),
  // Pro makes swe-2-medium free - so a log that was charged for it is not Pro.
  ...PRICE_ROWS.map(([id, p]) => priceRow('TEAMS_TIER_PRO', id, id === 'swe-2-medium' ? [0, 0, 0, 0] : p.map((v) => v * scale))),
], null, 2)};\n\n<ModelTable data={modelCostData} />\n`;
fs.writeFileSync(usagePrices, priceText());
const USAGE_P1 = path.join(usageDir, 'proj-one');
const USAGE_P2 = path.join(usageDir, 'proj-two');
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
{
  const U = await import('../usage.mjs');
  ok('usage: empty text is zero tokens', U.estimateTokens('') === 0 && U.estimateTokens(null) === 0);
  ok('usage: English splits like a BPE tokenizer', U.estimateTokens('Hello, world!') === 4, String(U.estimateTokens('Hello, world!')));
  const ar = U.estimateTokens('اعمل صفحة تسجيل دخول');
  ok('usage: Arabic costs more tokens per word than English', ar >= 6 && ar <= 14, String(ar));
  const code = U.estimateTokens('const x = foo(bar, 42);\nreturn x;');
  ok('usage: code counts its symbols', code >= 10 && code <= 20, String(code));
  ok('usage: longer text never estimates fewer tokens',
    U.estimateTokens('add a login page') < U.estimateTokens('add a login page with email validation and a reset link'));
  ok('usage: CRLF counts like LF', U.estimateTokens('a\r\nb\r\nc') === U.estimateTokens('a\nb\nc'));
  ok('usage: prompts are classified',
    U.classifyPrompt('/flow task "add login" --gates=auto').flow === 'task'
    && U.classifyPrompt('/flow task "add login"').task === 'add login'
    && U.classifyPrompt('/understand --gates=auto').flow === 'understand'
    && U.classifyPrompt(`${U.REFINE_MARK}\nrules`, 'x\nUser request:\nاعمل صفحة').task === 'اعمل صفحة'
    && U.classifyPrompt('hello there').kind === 'chat');
  ok('usage: model families group versions and levels',
    U.modelFamily('claude-opus-5-high') === 'claude-opus' && U.modelFamily('claude-opus-5-5-xhigh') === 'claude-opus'
    && U.modelFamily('swe-1-7-lightning') === 'swe' && U.modelFamily('gemini-3-7-flash-high') === 'gemini'
    && U.modelFamily('kimi-k2-7') === 'kimi' && U.modelFamily('opus') === 'opus');

  // The pipeline model: a bottom-up estimate straight from the flow file.
  const pipeFlow = { stages: [
    { id: 'scan', agent: null, prompt: '' },
    { id: 'think', agent: 'thinker', model: 'claude-opus-5-high', effort: 'high', prompt: 'Plan {TASK}' },
    { id: 'code', agent: 'coder', model: 'claude-opus-5-high', effort: 'high', prompt: 'Code it' },
    { id: 'test', agent: 'tester', model: 'claude-sonnet-5-high', effort: 'low', onFail: 'debug', maxLoops: 3, prompt: 'Test' },
    { id: 'debug', agent: 'debugger', model: 'claude-opus-5-max', effort: 'max', runOnlyWhenJumpedTo: true, next: 'test', prompt: 'Fix' },
  ] };
  const shape0 = U.callShape([]);
  const pipe = U.pipelineEstimate({ flowDef: pipeFlow, promptTokens: 20, shape: shape0 });
  const P0 = Object.fromEntries(pipe.stages.map((s) => [s.id, s]));
  ok('usage: pipeline — a script stage costs no model calls', P0.scan.kind === 'script' && P0.scan.calls === 0);
  ok('usage: pipeline — retry-only stages stay out of the happy path',
    P0.debug.kind === 'retry-only' && pipe.happy.calls === pipe.orchestrator.calls + P0.think.calls + P0.code.calls + P0.test.calls);
  ok('usage: pipeline — one failed check adds its target and a re-run',
    pipe.retryPaths.length === 1 && pipe.retryPaths[0].from === 'test' && pipe.retryPaths[0].to === 'debug'
    && pipe.withRetry.calls === pipe.happy.calls + P0.debug.calls + P0.test.calls);
  ok('usage: pipeline — role and effort drive the calls',
    P0.code.calls > P0.think.calls && P0.test.calls < 14 && P0.debug.calls > 18);
  ok('usage: pipeline — later stages open with the earlier artifacts', P0.code.tokens / P0.code.calls > P0.think.tokens / P0.think.calls * 0.9 && P0.test.fresh > 0);
  ok('usage: pipeline — no rates means tokens without a made-up price', pipe.happy.tokens > 0 && pipe.happy.acu === null && !shape0.measured);
  const fastPipe = U.pipelineEstimate({ flowDef: pipeFlow, speed: 'fast', shape: shape0 });
  const F0 = Object.fromEntries(fastPipe.stages.map((s) => [s.id, s]));
  ok('usage: pipeline — --speed=fast swaps models and effort like the skill does',
    fastPipe.speed === 'fast' && F0.think.model === 'swe-1-7-lightning' && F0.test.model === 'gemini-3-7-flash-high'
    && F0.code.effort === 'low' && fastPipe.happy.calls < pipe.happy.calls && F0.test.maxLoops === 1);

  if (HAS_SQLITE) {
    const db = new sqliteLib.DatabaseSync(usageDb);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
      model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
      title TEXT, metadata TEXT, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id));`);
    const addS = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)');
    const addN = db.prepare('INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) VALUES (?, ?, NULL, ?, ?, NULL)');
    const call = (rid, model, i, o, cr, acu, at) => JSON.stringify({ role: 'assistant', content: 'ok', metadata: {
      request_id: rid, generation_model: model, committed_acu_cost: acu, created_at: at,
      metrics: { input_tokens: i, output_tokens: o, cache_read_tokens: cr, cache_creation_tokens: 0 } } });
    const session = (id, dir, first, startIso, calls, reported) => {
      addS.run(id, dir, 'windsurf', 'adaptive', 'normal', sec(startIso), sec(startIso) + 600, `title ${id}`,
        JSON.stringify({ total_credit_cost: 0, total_acu_cost: reported }));
      let n = 0;
      addN.run(id, n++, JSON.stringify({ role: 'system', content: 'You are Devin.' }), sec(startIso));
      addN.run(id, n++, JSON.stringify({ role: 'user', content: first }), sec(startIso));
      for (const c of calls) addN.run(id, n++, c, sec(startIso));
    };
    const c1 = call('r1', 'claude-opus-5-5-xhigh', 1000, 200, 5000, 0.5, '2026-09-10T12:00:00Z');
    session('flow-a', USAGE_P1, '/flow task "add login page" --gates=dashboard', '2026-09-10T11:59:00Z',
      [c1, c1, call('r2', 'swe-2-medium', 300, 50, 0, 0.1, '2026-09-10T12:05:00Z')], 0.6);
    session('flow-b', USAGE_P1, '/flow task "fix the bug" --gates=auto', '2026-09-12T12:00:00Z',
      [call('r3', 'claude-opus-5-5-xhigh', 2000, 400, 8000, 0.9, '2026-09-12T12:01:00Z')], 0.9);
    session('refine-1', USAGE_P2, `${U.REFINE_MARK}\nRules...\n\nUser request:\nاعمل صفحة`, '2026-09-11T12:00:00Z',
      [call('r4', 'kimi-k2-7', 400, 100, 0, 0.01, '2026-09-11T12:00:30Z')], 0.01);
    session('chat-1', USAGE_P2, 'hello devin', '2026-08-20T12:00:00Z',
      [call('r5', 'kimi-k2-7', 5000, 900, 20000, 2.0, '2026-08-20T12:02:00Z')], 2.0);
    db.close();
    process.env.FF_DEVIN_SESSIONS_DB = usageDb;

    const log = await U.readDevinSessions({ force: true });
    const byId = Object.fromEntries(log.sessions.map((s) => [s.id, s]));
    ok('usage: Devin\'s session log is read', log.available === true && log.sessions.length === 4, JSON.stringify(log.message));
    ok('usage: a compaction copy of a call is counted once',
      byId['flow-a'].turns === 2 && Math.abs(byId['flow-a'].acu - 0.6) < 1e-9 && byId['flow-a'].input === 1300,
      JSON.stringify({ t: byId['flow-a'].turns, a: byId['flow-a'].acu }));
    ok('usage: sessions are recognised as flow runs, prompt generation and chat',
      byId['flow-a'].kind === 'flow' && byId['flow-a'].flow === 'task' && byId['flow-a'].task === 'add login page'
      && byId['refine-1'].kind === 'refine' && byId['refine-1'].task === 'اعمل صفحة' && byId['chat-1'].kind === 'chat');

    const now = Date.parse('2026-09-20T12:00:00Z');
    const agg = U.aggregateUsage(log.sessions, { month: '2026-09', now });
    ok('usage: month totals come from the calls inside the month',
      Math.abs(agg.totals.acu - 1.51) < 1e-9 && agg.totals.sessions === 3 && agg.totals.runs === 2 && agg.totals.turns === 4,
      JSON.stringify(agg.totals));
    ok('usage: the previous month is compared', Math.abs(agg.prev.acu - 2.0) < 1e-9 && agg.prev.sessions === 1);
    ok('usage: the month-end projection extrapolates the pace', Math.abs(agg.projection - (1.51 / 20) * 30) < 1e-6, String(agg.projection));
    ok('usage: every model gets its share and its measured rate',
      agg.byModel[0].model === 'claude-opus-5-5-xhigh' && Math.abs(agg.byModel[0].acu - 1.4) < 1e-9
      && Math.abs(agg.byModel.reduce((a, m) => a + m.share, 0) - 1) < 1e-9 && agg.byModel[0].acuPerMTok > 0);
    ok('usage: one bar per day of the month',
      agg.daily.length === 30 && Math.abs(agg.daily.find((d) => d.day === '2026-09-10').acu - 0.6) < 1e-9);
    ok('usage: per project and per flow',
      agg.byProject.length === 2 && agg.byFlow.length === 1 && agg.byFlow[0].runs === 2 && Math.abs(agg.byFlow[0].avgAcu - 0.75) < 1e-9);
    const aug = U.aggregateUsage(log.sessions, { month: '2026-08', now });
    const augFf = U.aggregateUsage(log.sessions, { month: '2026-08', scope: 'flowforge', now });
    ok('usage: scope=flowforge leaves out ordinary chat sessions', aug.totals.acu === 2 && augFf.totals.acu === 0 && aug.projection === null);

    const linked = U.linkRuns(log.sessions.map((s) => ({ ...s })), [
      { sessionId: 'chat-1', flow: 'bugfix', task: 'crash on start', exitCode: 0, mode: 'acp', startedAt: '2026-08-20T12:00:00Z' },
      { sessionId: null, flow: 'task', project: USAGE_P1, exitCode: 2, mode: 'cli', startedAt: '2026-09-12T12:00:30Z' },
    ]);
    const L = Object.fromEntries(linked.map((s) => [s.id, s]));
    ok('usage: the run log turns a session into the FlowForge run it was',
      L['chat-1'].kind === 'flow' && L['chat-1'].flow === 'bugfix' && L['chat-1'].run.exitCode === 0 && byId['chat-1'].kind === 'chat');
    ok('usage: a CLI run is matched to its session by project and start time', L['flow-b'].run && L['flow-b'].run.exitCode === 2);

    const est = U.estimateRun({
      flow: 'task', task: 'add a login page',
      flowDef: { stages: [{ id: 'think', model: 'claude-opus-5-high' }, { id: 'ship', agent: 'shipper' }, { id: 'odd', model: 'mystery-1' }] },
      parts: [{ name: 'skill', text: 'word '.repeat(500) }], sessions: log.sessions, agentModels: { shipper: 'swe' },
    });
    ok('usage: the forecast is calibrated on past runs of the same flow',
      est.forecast && est.forecast.basis === 'this-flow' && est.forecast.runs === 2 && Math.abs(est.forecast.acu.p50 - 0.75) < 1e-9,
      JSON.stringify(est.forecast));
    ok('usage: each stage is priced at the rate measured for its model',
      est.stages[0].basis === 'family' && est.stages[0].rate > 0 && est.stages[1].basis === 'family'
      && est.stages[2].basis === 'account' && est.stages.every((s) => s.openAcu > 0),
      JSON.stringify(est.stages.map((s) => [s.basis, s.rate])));
    ok('usage: prompt and overhead are counted', est.promptTokens > 0 && est.overheadTokens >= 500 && est.baselineTokens > 0);
    ok('usage: with real runs the pipeline estimate is calibrated to their median',
      est.pipeline.calibration && est.pipeline.calibration.runs === 2 && Math.abs(est.pipeline.happy.acu - 0.75) < 1e-9,
      JSON.stringify({ c: est.pipeline.calibration, a: est.pipeline.happy.acu }));
    const estFast = U.estimateRun({ flow: 'task', task: 'x', speed: 'fast', sessions: log.sessions,
      flowDef: { stages: [{ id: 'think', agent: 'thinker', model: 'claude-opus-5-high', effort: 'high' }, { id: 'ship', agent: 'shipper' }] } });
    ok('usage: a faster speed forecasts a cheaper run than the calibrated default',
      estFast.pipeline.speed === 'fast' && estFast.pipeline.happy.acu > 0 && estFast.pipeline.happy.acu < 0.75,
      String(estFast.pipeline.happy.acu));
    const other = U.estimateRun({ flow: 'bugfix', task: 'x', flowDef: { stages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      sessions: log.sessions, stageCounts: { task: 6, bugfix: 3 } });
    ok('usage: a flow never run yet borrows the per-stage cost of other flows',
      other.forecast && other.forecast.basis === 'other-flows' && Math.abs(other.forecast.acu.p50 - 0.375) < 1e-9,
      JSON.stringify(other.forecast && other.forecast.acu));

    // Dollars: parse the price list, then measure the ACU -> $ rate on the log.
    const table = U.parsePriceTable(fs.readFileSync(usagePrices, 'utf8'));
    ok('usage: Devin\'s price list is parsed per model and tier',
      table && table['claude-opus-5-high'].enterprise.join() === '5,25,6.25,0.5' && table['swe-2-medium'].pro.join() === '0,0,0,0'
      && U.parsePriceTable('no table here') === null);
    ok('usage: the page\'s escaped-JSON form parses too',
      !!U.parsePriceTable(`x modelCostData = [{"tier":"TEAMS_TIER_PRO","model_uid":"a-1","label":"say \\"hi\\" ]","input_cost_per_million_usd":1,"output_cost_per_million_usd":2,"cache_write_cost_per_million_usd":0,"cache_read_cost_per_million_usd":0.1}] y`));
    const dr = U.dollarRate(log.sessions, table);
    ok('usage: the ACU -> $ rate is measured call by call against the price list',
      dr.basis === 'measured' && dr.usdPerAcu === 2 && dr.tier === 'enterprise' && dr.verified === 5 && dr.priced === 5,
      JSON.stringify(dr));
    const dr11 = U.dollarRate(log.sessions, U.parsePriceTable(priceText(1.1)));
    ok('usage: a different price list gives a different rate - nothing is hard-coded', dr11.usdPerAcu === 2.2, JSON.stringify(dr11));
    ok('usage: without a price list the rate says it is a default', U.dollarRate(log.sessions, null).basis === 'default');
    const estP = U.estimateRun({ flow: 'bugfix', task: 'x', sessions: log.sessions, prices: table,
      flowDef: { stages: [{ id: 'a', agent: 'coder', model: 'claude-opus-5-high' }, { id: 'b', agent: 'tester', model: 'mystery-9' }] } });
    const [sa, sb] = estP.pipeline.stages;
    ok('usage: a stage on the price list is priced from it, token class by token class',
      sa.basis === 'price-list' && sa.usd > 0 && Math.abs(sa.acu * 2 - sa.usd) < 1e-12
      && Math.abs(sa.usd - (sa.fresh * 6.25 + sa.cacheRead * 0.5 + sa.output * 25) / 1e6) < 1e-12,
      JSON.stringify({ b: sa.basis, u: sa.usd, a: sa.acu }));
    ok('usage: a model missing from the list falls back to the measured rate',
      sb.basis === 'account' && sb.usd > 0 && estP.dollars.usdPerAcu === 2 && estP.pipeline.happy.usd > 0);
    const md = U.usageReportMarkdown(agg, { usdPerAcu: 2 });
    ok('usage: the monthly report carries totals, models, tasks and money',
      md.includes('# Usage report — 2026-09') && md.includes('| ACUs spent | 1.51 |') && md.includes('flow:task')
      && md.includes('$3.02') && md.includes('claude-opus-5-5-xhigh'));
    ok('usage: the report speaks Arabic too', U.usageReportMarkdown(agg, { lang: 'ar' }).includes('تقرير الاستخدام'));
    const live = await U.readSessionUsage('flow-a');
    ok('usage: a single session is read live', live && live.turns === 2 && Math.abs(live.acu - 0.6) < 1e-9);
    ok('usage: a CLI run finds its session', (await U.findSessionFor(USAGE_P1, Date.parse('2026-09-12T12:00:00Z'))) === 'flow-b');
  } else {
    process.env.FF_DEVIN_SESSIONS_DB = usageDb;
    const log = await U.readDevinSessions({ force: true });
    ok('usage: without the log it says so instead of failing', log.available === false && !!log.message);
  }
  delete process.env.FF_DEVIN_SESSIONS_DB;
}

// ---------- usage: every other tool's own records ----------
console.log('# usage sources checks');
// One fake home holding each tool's records in its real on-disk shape; the
// test server reads the same home. All dated October 2026 so the Devin-only
// September assertions above stay exact.
const toolHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tools-'));
const toolLogDir = path.join(toolHome, 'usage-logs');
const litePrices = path.join(usageDir, 'litellm.json');
fs.writeFileSync(litePrices, JSON.stringify({
  'claude-sonnet-4-5-20250929': { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_creation_input_token_cost: 3.75e-6, cache_read_input_token_cost: 0.3e-6 },
  'claude-opus-4-6': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_creation_input_token_cost: 6.25e-6, cache_read_input_token_cost: 0.5e-6 },
  'openai/gpt-5': { input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.125e-6 },
  'gemini/gemini-2.5-pro': { input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.31e-6 },
  sample_spec: { max_tokens: 'n/a' },
}));
const fakeGh = path.join(usageDir, 'fake-gh.mjs');
fs.writeFileSync(fakeGh, [
  "const a = process.argv.slice(2).join(' ');",
  "if (a.startsWith('api user')) { console.log(process.env.FAKE_GH_LOGIN || 'octo'); process.exit(0); }",
  "if (process.env.FAKE_GH_DENY === '1') { console.error('gh: Resource not accessible by integration (HTTP 403)'); process.exit(1); }",
  "if (a.includes('premium_request/usage') && a.includes('year=2026&month=10&day=1')) {",
  "  console.log(JSON.stringify({ usageItems: [{ product: 'Copilot', model: 'Claude Sonnet 4', grossQuantity: 3, grossAmount: 0.12, netAmount: 0.04, pricePerUnit: 0.04 }] })); process.exit(0); }",
  "console.log(JSON.stringify({ usageItems: [] }));",
].join('\n'));
const OCT = (d, h = 12) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
{
  const S = await import('../usage-sources.mjs');
  const U = await import('../usage.mjs');
  const P = await import('../../scripts/lib/platform.mjs');
  const env = { FF_TOOL_HOME: toolHome, FF_USAGE_DIR: toolLogDir };
  const R = P.toolRoots(process.platform, env);
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

  // Claude Code: a duplicated assistant line (same message + request id).
  const cl = { type: 'assistant', sessionId: 'cs-1', cwd: '/work/app', timestamp: OCT(2), requestId: 'req-1',
    message: { id: 'msg-1', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } };
  put(path.join(toolHome, '.claude', 'projects', '-work-app', 'cs-1.jsonl'),
    [JSON.stringify({ type: 'user', message: { content: 'hi' } }), JSON.stringify(cl), JSON.stringify(cl)].join('\n'));
  // Codex: a repeated total (no new call) and a totals-only event (delta).
  put(path.join(toolHome, '.codex', 'sessions', '2026', '10', '03', 'rollout-x.jsonl'), [
    { type: 'session_meta', timestamp: OCT(3), payload: { id: 'cx-1', cwd: '/work/api' } },
    { type: 'turn_context', timestamp: OCT(3), payload: { model: 'gpt-5' } },
    { type: 'event_msg', timestamp: OCT(3), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 300 }, total_token_usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 300 } } } },
    { type: 'event_msg', timestamp: OCT(3), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 300 }, total_token_usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 300 } } } },
    { type: 'event_msg', timestamp: OCT(3, 13), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 3000, cached_input_tokens: 700, output_tokens: 400 } } } },
  ].map((o) => JSON.stringify(o)).join('\n'));
  // Gemini CLI: cached tokens are part of the prompt count; thoughts bill as output.
  put(path.join(toolHome, '.gemini', 'tmp', 'abc123', 'chats', 'session-1.json'), JSON.stringify({ sessionId: 'gm-1', startTime: OCT(4), messages: [
    { type: 'user', content: 'x' },
    { type: 'gemini', id: 'g1', model: 'gemini-2.5-pro', timestamp: OCT(4), tokens: { input: 1200, output: 100, cached: 200, thoughts: 50, total: 1350 } },
  ] }));
  // OpenCode: the cost OpenCode computed is kept as is.
  put(path.join(toolHome, '.local', 'share', 'opencode', 'storage', 'message', 'ses_1', 'msg_1.json'), JSON.stringify({
    id: 'msg_1', sessionID: 'ses_1', role: 'assistant', modelID: 'claude-sonnet-4-5', providerID: 'anthropic',
    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 0 } }, cost: 0.0123, time: { created: Date.parse(OCT(5)) } }));
  // Cline (VS Code): cost per API request.
  put(path.join(R.appdata, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', 't-1', 'ui_messages.json'), JSON.stringify([
    { ts: Date.parse(OCT(6)), type: 'say', say: 'task', text: 'fix the login bug' },
    { ts: Date.parse(OCT(6)), type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 100, tokensOut: 50, cacheWrites: 10, cacheReads: 200, cost: 0.004 }) },
    { ts: Date.parse(OCT(6)), type: 'say', say: 'text', text: 'done' },
  ]));
  // Aider: the analytics log FlowForge points AIDER_ANALYTICS_LOG at.
  put(path.join(toolLogDir, 'aider.jsonl'), [
    { event: 'launched', properties: {}, time: Date.parse(OCT(7)) / 1000 },
    { event: 'message_send', properties: { main_model: 'gpt-5', prompt_tokens: 9000, completion_tokens: 400, cost: 0.0153, total_cost: 0.0153 }, time: Date.parse(OCT(7)) / 1000 },
    { event: 'message_send', properties: { main_model: 'gpt-5', prompt_tokens: 9000, completion_tokens: 400, cost: 0.0153, total_cost: 0.0153 }, time: Date.parse(OCT(7)) / 1000 },
  ].map((o) => JSON.stringify(o)).join('\n'));
  // Copilot CLI: OpenTelemetry chat spans; the repeat and a non-chat span are ignored.
  const span = { type: 'span', name: 'chat gpt-4.1', endTime: [Date.parse(OCT(8)) / 1000, 0], attributes: {
    'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 500, 'gen_ai.usage.output_tokens': 40,
    'gen_ai.usage.cache_read.input_tokens': 100, 'gen_ai.response.model': 'gpt-4.1', 'gen_ai.response.id': 'r1', 'gen_ai.conversation.id': 'c1' } };
  put(path.join(toolLogDir, 'copilot-otel.jsonl'), [span, span, { type: 'span', name: 'execute_tool x', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.usage.input_tokens': 9 } }]
    .map((o) => JSON.stringify(o)).join('\n'));

  // Cursor: the real hook script, fed the payload Cursor sends on stdin.
  const hook = path.join(WORKBENCH, 'scripts', 'usage-hook.mjs');
  const hookEnv = { ...process.env, FF_USAGE_DIR: toolLogDir };
  const h1 = spawnSync(process.execPath, [hook, 'cursor'], { input: JSON.stringify({
    hook_event_name: 'stop', conversation_id: 'cv-1', generation_id: 'gen-1', model: 'claude-4.6-opus-high-thinking',
    input_tokens: 1000, output_tokens: 50, cache_read_tokens: 600, cache_write_tokens: 100, user_email: 'me@x.io',
    workspace_roots: ['/work/web'], status: 'completed' }), env: hookEnv, encoding: 'utf8' });
  const h2 = spawnSync(process.execPath, [hook, 'cursor'], { input: JSON.stringify({ hook_event_name: 'stop', status: 'completed' }), env: hookEnv, encoding: 'utf8' });
  const h3 = spawnSync(process.execPath, [hook, 'cursor'], { input: 'not json', env: hookEnv, encoding: 'utf8' });
  const cursorLog = fs.readFileSync(path.join(toolLogDir, 'cursor.jsonl'), 'utf8').trim().split('\n');
  ok('usage sources: the Cursor hook records usage numbers only, answers {} and never fails',
    h1.status === 0 && h1.stdout === '{}' && h2.status === 0 && h3.status === 0 && h3.stdout === '{}'
    && cursorLog.length === 1 && !cursorLog[0].includes('me@x.io') && JSON.parse(cursorLog[0]).input_tokens === 1000,
    JSON.stringify({ s: [h1.status, h2.status, h3.status], n: cursorLog.length }));
  // The hook stamps "now"; move the record into the fixture month.
  fs.writeFileSync(path.join(toolLogDir, 'cursor.jsonl'), `${JSON.stringify({ ...JSON.parse(cursorLog[0]), ts: Date.parse(OCT(8)) })}\n`);

  // Antigravity: protobuf rows exactly as the upstream reader decodes them.
  if (HAS_SQLITE) {
    const vi = (v) => { const out = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 128; out.push(b); } while (v); return out; };
    const fv = (n, v) => Buffer.from([...vi(n * 8), ...vi(v)]);
    const fb = (n, b) => Buffer.concat([Buffer.from([...vi(n * 8 + 2), ...vi(b.length)]), Buffer.from(b)]);
    const ts = (s) => fv(1, s);
    const usage = Buffer.concat([fv(1, 1071), fv(2, 4050), fv(3, 375), fv(5, 16275), fb(11, Buffer.from('resp-a'))]);
    const step = Buffer.concat([fb(1, ts(Date.parse(OCT(9)) / 1000)), fb(9, usage)]);
    const gen = fb(1, Buffer.concat([fb(4, usage), fb(9, fb(4, ts(Date.parse(OCT(9)) / 1000))), fb(19, Buffer.from('gemini-2.5-pro'))]));
    const agDb = path.join(toolHome, '.gemini', 'antigravity', 'conversations', 'conv-1.db');
    fs.mkdirSync(path.dirname(agDb), { recursive: true });
    const adb = new sqliteLib.DatabaseSync(agDb);
    adb.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    adb.prepare('INSERT INTO steps VALUES (0, ?)').run(step);
    adb.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(gen);
    adb.close();
    // Zed: one zstd-compressed thread with two requests.
    const zedDb = process.platform === 'darwin' ? path.join(R.appdata, 'Zed', 'threads', 'threads.db')
      : process.platform === 'win32' ? path.join(R.localData, 'Zed', 'threads', 'threads.db') : path.join(R.xdgData, 'zed', 'threads', 'threads.db');
    fs.mkdirSync(path.dirname(zedDb), { recursive: true });
    const zlib = await import('node:zlib');
    const thread = JSON.stringify({ title: 'refactor', updated_at: OCT(10), model: { provider: 'zed.dev', model: 'claude-sonnet-4-5' },
      request_token_usage: { a: { input_tokens: 100, output_tokens: 10 }, b: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 50 } } });
    const zstd = typeof zlib.zstdCompressSync === 'function';
    const zdb = new sqliteLib.DatabaseSync(zedDb);
    zdb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL, folder_paths TEXT)');
    zdb.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('th-1', 'refactor', OCT(10), zstd ? 'zstd' : 'json',
      zstd ? zlib.zstdCompressSync(Buffer.from(thread)) : Buffer.from(thread), '/work/zed-proj');
    zdb.close();
  }

  // Price list: Devin's table (from the fixture) plus LiteLLM.
  process.env.FF_LITELLM_PRICES = litePrices;
  const liteState = await S.refreshLiteLLM({});
  const devinTable = U.parsePriceTable(fs.readFileSync(usagePrices, 'utf8'));
  const pricer = S.makePricer(devinTable, liteState.table);
  delete process.env.FF_LITELLM_PRICES;
  ok('usage sources: LiteLLM prices are parsed and matched on normalised names',
    !!liteState.table && pricer('anthropic/claude-sonnet-4-5-20250929').source === 'litellm'
    && pricer('claude-4.6-opus-high-thinking').price[0] === 5 && pricer('claude-sonnet-5-high').source === 'devin' && pricer('nope-1') === null);

  const all = await S.readAllSources({ env, pricer });
  const byTool = (t) => all.sessions.filter((s) => s.tool === t);
  const one = (t) => byTool(t)[0] || { calls: [] };
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  ok('usage sources: Claude Code - one call per message, priced at list price',
    byTool('claude').length === 1 && one('claude').turns === 1 && one('claude').project === '/work/app'
    && near(one('claude').usd, (1000 * 3 + 200 * 15 + 100 * 3.75 + 5000 * 0.3) / 1e6), JSON.stringify({ t: one('claude').turns, u: one('claude').usd }));
  ok('usage sources: Codex - repeated totals skipped, totals-only events become deltas',
    one('codex').turns === 2 && one('codex').input === 1500 + 800 && one('codex').cacheRead === 700 && one('codex').output === 400
    && one('codex').project === '/work/api' && one('codex').usd > 0, JSON.stringify({ t: one('codex').turns, i: one('codex').input, c: one('codex').cacheRead }));
  ok('usage sources: Gemini CLI - cached split out of the prompt, thoughts billed as output',
    one('gemini').input === 1000 && one('gemini').cacheRead === 200 && one('gemini').output === 150 && one('gemini').usd > 0);
  ok('usage sources: OpenCode keeps the cost OpenCode computed', near(one('opencode').usd, 0.0123) && one('opencode').output === 25);
  ok('usage sources: Cline keeps its per-request cost and task title',
    near(one('cline').usd, 0.004) && one('cline').cacheRead === 200 && one('cline').title === 'fix the login bug');
  ok('usage sources: Aider - duplicates dropped, its own cost kept', one('aider').turns === 1 && near(one('aider').usd, 0.0153));
  ok('usage sources: Cursor hook records become priced calls (cache split out of input)',
    one('cursor').input === 300 && one('cursor').cacheRead === 600 && one('cursor').cacheWrite === 100 && one('cursor').project === '/work/web'
    && near(one('cursor').usd, (300 * 5 + 50 * 25 + 100 * 6.25 + 600 * 0.5) / 1e6), JSON.stringify({ i: one('cursor').input, u: one('cursor').usd }));
  ok('usage sources: Copilot CLI spans give tokens at $0 (Copilot bills requests, not tokens)',
    one('copilot').turns === 1 && one('copilot').input === 400 && one('copilot').usd === 0 && one('copilot').model === 'gpt-4.1');
  if (HAS_SQLITE) {
    ok('usage sources: Antigravity protobuf decoded, named from gen_metadata, deduplicated',
      one('antigravity').turns === 1 && one('antigravity').model === 'gemini-2.5-pro' && one('antigravity').input === 4050
      && one('antigravity').cacheRead === 16275 && one('antigravity').output === 375, JSON.stringify(one('antigravity').calls));
    ok('usage sources: Zed threads.db read (zstd JSON), one call per request',
      one('zed').turns === 2 && one('zed').input === 300 && one('zed').cacheRead === 50 && one('zed').project === '/work/zed-proj' && one('zed').usd > 0,
      JSON.stringify({ t: one('zed').turns, n: all.status.zed }));
  }
  ok('usage sources: each tool reports what it found', all.status.claude.found && all.status.cursor.found && !all.status.windsurf);

  // Copilot billing through a fake gh: real dollars per model, per day.
  const billFile = path.join(toolLogDir, 'copilot-billing.json');
  const ghEnv = { ...process.env, FF_GH: fakeGh };
  const st = await S.refreshCopilotBilling({ cacheFile: billFile, month: '2026-10', env: ghEnv, now: Date.parse(OCT(3)) });
  const bill = JSON.parse(fs.readFileSync(billFile, 'utf8'));
  const billed = S.billingSessions(bill);
  ok('usage sources: Copilot billing - GitHub\'s report becomes billed dollars and premium requests',
    st.status === 'ok' && bill.login === 'octo' && Object.keys(bill.days).length === 3
    && billed.length === 1 && near(billed[0].usd, 0.04) && billed[0].requests === 3, JSON.stringify({ s: st.status, d: Object.keys(bill.days) }));
  fs.rmSync(billFile);
  const denied = await S.refreshCopilotBilling({ cacheFile: billFile, month: '2026-10', env: { ...ghEnv, FAKE_GH_DENY: '1' }, now: Date.parse(OCT(3)) });
  ok('usage sources: a refused billing report says why and how to fix it', denied.status === 'forbidden' && /permission/i.test(denied.message));
  const noGh = await S.refreshCopilotBilling({ cacheFile: billFile, month: '2026-10', env: { PATH: '', FF_GH: '' }, plat: 'linux', now: Date.parse(OCT(3)) });
  ok('usage sources: no gh on the machine is reported, not crashed on', noGh.status === 'no-gh');

  // Mixed aggregation: every tool in dollars, Devin in ACUs too.
  const aggAll = U.aggregateUsage(all.sessions.concat(billed), { month: '2026-10', usdPerAcu: 2 });
  const sumTools = aggAll.byTool.reduce((a, x) => a + x.usd, 0);
  ok('usage sources: the month adds every tool up in dollars, by tool',
    aggAll.byTool.length >= 8 && near(aggAll.totals.usd, sumTools) && aggAll.totals.requests === 3
    && aggAll.tasks.some((x) => x.tool === 'cursor'), JSON.stringify(aggAll.byTool.map((x) => [x.tool, x.usd])));
  const aggClaude = U.aggregateUsage(all.sessions, { month: '2026-10', tool: 'claude' });
  ok('usage sources: the tool filter narrows everything to one tool', aggClaude.byTool.length === 1 && aggClaude.totals.sessions === 1);
  const unp = S.priceSessions([{ calls: [{ ms: 1, day: '2026-10-01', model: 'mystery-9', input: 5, output: 5, cacheRead: 0, cacheWrite: 0, acu: 0 }] }], pricer);
  ok('usage sources: a model no price list knows is reported as unpriced', unp.length === 1 && unp[0] === 'mystery-9');

  // Cursor hook installer: merges into the user's hooks.json, never duplicates,
  // removes only its own entry, and refuses to touch a broken file.
  const hooksFile = S.cursorHooksFile(process.platform, env);
  put(hooksFile, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'my-own-hook.sh' }], afterFileEdit: [{ command: 'fmt.sh' }] } }));
  S.setCursorHook(true, { hookScript: hook, env });
  S.setCursorHook(true, { hookScript: hook, env });
  const withHook = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  ok('usage sources: the Cursor hook is merged in once, next to the user\'s own hooks',
    withHook.hooks.stop.length === 2 && withHook.hooks.stop.some((h) => h.command === 'my-own-hook.sh')
    && withHook.hooks.afterFileEdit.length === 1 && S.cursorHookInstalled(process.platform, env));
  S.setCursorHook(false, { hookScript: hook, env });
  const withoutHook = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  ok('usage sources: switching off removes only FlowForge\'s hook',
    withoutHook.hooks.stop.length === 1 && withoutHook.hooks.stop[0].command === 'my-own-hook.sh' && !S.cursorHookInstalled(process.platform, env));
  fs.writeFileSync(hooksFile, '{ broken');
  let refused = false;
  try { S.setCursorHook(true, { hookScript: hook, env }); } catch { refused = true; }
  ok('usage sources: a hooks.json that is not valid JSON is never overwritten', refused && fs.readFileSync(hooksFile, 'utf8') === '{ broken');
  fs.rmSync(hooksFile);

  // Environment variables: a marked profile block on POSIX, setx / reg on Windows.
  const posixEnv = { FF_TOOL_HOME: path.join(toolHome, 'posix'), FF_USAGE_DIR: path.join(toolHome, 'posix-logs') };
  fs.mkdirSync(posixEnv.FF_TOOL_HOME, { recursive: true });
  const profile = path.join(posixEnv.FF_TOOL_HOME, '.profile');
  fs.writeFileSync(profile, 'export PATH="$HOME/bin:$PATH"\n');
  S.setTrackedEnv('aider', true, { plat: 'linux', env: posixEnv });
  S.setTrackedEnv('copilot', true, { plat: 'linux', env: posixEnv });
  const both = fs.readFileSync(profile, 'utf8');
  S.setTrackedEnv('aider', false, { plat: 'linux', env: posixEnv });
  const copilotOnly = fs.readFileSync(profile, 'utf8');
  S.setTrackedEnv('copilot', false, { plat: 'linux', env: posixEnv });
  const restored = fs.readFileSync(profile, 'utf8');
  ok('usage sources: POSIX - one marked profile block holds every enabled variable, and goes away cleanly',
    both.includes('AIDER_ANALYTICS_LOG=') && both.includes('COPILOT_OTEL_EXPORTER_TYPE=\'file\'') && both.startsWith('export PATH=')
    && !copilotOnly.includes('AIDER_ANALYTICS_LOG') && copilotOnly.includes('COPILOT_OTEL_ENABLED')
    && restored.trim() === 'export PATH="$HOME/bin:$PATH"', restored);
  const calls = [];
  const winEnv = { FF_TOOL_HOME: path.join(toolHome, 'win'), FF_USAGE_DIR: path.join(toolHome, 'win-logs') };
  const wOn = S.setTrackedEnv('aider', true, { plat: 'win32', env: winEnv, run: (c, a) => calls.push([c, ...a]) });
  const wOff = S.setTrackedEnv('aider', false, { plat: 'win32', env: winEnv, run: (c, a) => calls.push([c, ...a]) });
  ok('usage sources: Windows - setx to switch on, reg delete to switch off',
    wOn.commands[0].cmd === 'setx' && calls[0][1] === 'AIDER_ANALYTICS_LOG' && calls[1][0] === 'reg' && calls[1].includes('HKCU\\Environment') && !wOff.dry);
  const dryCalls = [];
  const dry = S.setTrackedEnv('copilot', true, { plat: 'win32', env: { ...winEnv, FF_USAGE_DRY: '1' }, run: () => dryCalls.push(1) });
  ok('usage sources: FF_USAGE_DRY lists the commands without running them', dry.dry && dry.commands.length === 3 && dryCalls.length === 0);
}

// ---------- scheduler: queue + timetable decisions ----------
console.log('# scheduler checks');
{
  const S = await import('../scheduler.mjs');
  const at = (iso) => Date.parse(iso);
  const base = new Date(2026, 8, 26, 10, 0, 0).getTime(); // local 2026-09-26 10:00
  const d1 = S.nextRunAt({ kind: 'daily', at: '11:30' }, base);
  const d2 = S.nextRunAt({ kind: 'daily', at: '09:00' }, base);
  ok('scheduler: daily fires later today or tomorrow, local time',
    new Date(d1).getHours() === 11 && new Date(d1).getDate() === 26 && new Date(d2).getDate() === 27 && new Date(d2).getHours() === 9);
  const w = S.nextRunAt({ kind: 'weekly', days: [1, 3], at: '08:00' }, base); // base is a Saturday
  ok('scheduler: weekly picks the next listed weekday', new Date(w).getDay() === 1 && new Date(w).getHours() === 8 && w > base);
  ok('scheduler: every N hours and once', S.nextRunAt({ kind: 'hours', every: 6 }, base) === base + 6 * 3600 * 1000
    && S.nextRunAt({ kind: 'once', at: '2026-10-01T00:00:00Z' }, base) === at('2026-10-01T00:00:00Z')
    && S.nextRunAt({ kind: 'once', at: '2020-01-01T00:00:00Z' }, base) === null
    && S.nextRunAt({ kind: 'daily', at: '25:00' }, base) === null && S.nextRunAt({ kind: 'weekly', days: [], at: '08:00' }, base) === null);
  const q = [
    { id: 'a', project: 'C:/p1', status: 'queued' }, { id: 'b', project: 'C:/p2/', status: 'queued' }, { id: 'c', project: 'C:/p3', status: 'queued' },
  ];
  ok('scheduler: the next item is the first whose project is idle, under the parallel cap',
    S.pickNext(q, { activeProjects: ['c:/p1'], activeCount: 1, maxParallel: 3 }).id === 'b'
    && S.pickNext(q, { activeProjects: ['c:/p1', 'C:/p2'], activeCount: 2, maxParallel: 2 }) === null
    && S.pickNext(q, { activeProjects: [], activeCount: 0, maxParallel: 3 }).id === 'a');
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-jobs-'));
  const store = new S.JobStore({ queueFile: path.join(jobDir, 'q.json'), schedulesFile: path.join(jobDir, 's.json') });
  await store.load();
  const i1 = store.enqueue({ project: 'C:/p1', flow: 'task', task: 'one' });
  const i2 = store.enqueue({ project: 'C:/p1', flow: 'task', task: 'two' });
  store.reorder(i2.id, i1.id);
  ok('scheduler: queue keeps order, reorders, cancels', store.queue[0].id === i2.id && store.cancel(i1.id) && !store.cancel(i1.id) && store.queue[1].status === 'cancelled');
  const sch = store.addSchedule({ project: 'C:/p1', flow: 'quality', task: 'nightly', repeat: { kind: 'hours', every: 1 } });
  sch.nextAt = Date.now() - 1000;
  const fired = store.fireDue();
  const firedAgain = (sch.nextAt = Date.now() - 1000, store.fireDue());
  ok('scheduler: a due schedule joins the queue once, and never piles up behind itself',
    fired.length === 1 && fired[0].scheduleId === sch.id && firedAgain.length === 0 && sch.nextAt > Date.now(), JSON.stringify({ f: fired.length, g: firedAgain.length }));
  store.markStarted(fired[0].id, 'run-1');
  store.markEnded(fired[0].id, 0);
  ok('scheduler: a finished item reports back to its schedule', store.queue.find((x) => x.id === fired[0].id).status === 'done' && sch.lastStatus === 'done');
  store.markStarted(i2.id, 'run-2');
  await store.save();
  const store2 = new S.JobStore({ queueFile: path.join(jobDir, 'q.json'), schedulesFile: path.join(jobDir, 's.json') });
  await store2.load();
  ok('scheduler: after a restart, an item that was running is reported failed, schedules survive',
    store2.queue.find((x) => x.id === i2.id).status === 'failed' && store2.schedules.length === 1 && typeof store2.schedules[0].nextAt === 'number');
  let refused = false;
  try { store2.addSchedule({ project: 'C:/p1', flow: 'task', task: 'x', repeat: { kind: 'once', at: '2001-01-01T00:00:00Z' } }); } catch { refused = true; }
  ok('scheduler: a schedule that can never fire is refused', refused);
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
// A fake Gemini CLI proves the "connected provider generates the prompt" path:
// logged in via its oauth creds file, answering `gemini -p` on stdout.
const gemSrvHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-gemsrv-'));
fs.mkdirSync(path.join(gemSrvHome, '.gemini', 'bin'), { recursive: true });
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(gemSrvHome, '.gemini', 'bin', 'gemini.cmd'), '@echo REFINED_VIA_GEMINI\r\n');
} else {
  const g = path.join(gemSrvHome, '.gemini', 'bin', 'gemini');
  fs.writeFileSync(g, '#!/bin/sh\necho REFINED_VIA_GEMINI\n');
  fs.chmodSync(g, 0o755);
}
fs.writeFileSync(path.join(gemSrvHome, '.gemini', 'oauth_creds.json'),
  JSON.stringify({ access_token: 'g.' + 'y'.repeat(120) }));
const server = spawn(process.execPath, [path.join(DASHBOARD, 'server.mjs'), scratch, String(PORT)],
  { stdio: 'pipe', env: { ...process.env, DEVIN_CLI: fakeCli, FF_NO_ACP: '1', FF_REGISTRY: registryFile,
    FF_PROVIDER_HOME_CURSOR: path.join(scratch, 'no-such-cursor'),
    FF_PROVIDER_HOME_GEMINI: gemSrvHome,
    FF_DEVIN_SESSIONS_DB: usageDb, FF_USAGE_RUNS: usageRunsFile, FF_DEVIN_PRICES: usagePrices,
    FF_TOOL_HOME: toolHome, FF_USAGE_DIR: toolLogDir, FF_LITELLM_PRICES: litePrices, FF_USAGE_DRY: '1', FF_GH: fakeGh,
    FF_QUEUE_FILE: path.join(scratch, 'queue.json'), FF_SCHEDULES_FILE: path.join(scratch, 'schedules.json'), FF_JOB_TICK_MS: '400', FF_MAX_PARALLEL: '2' } });
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
  ok('providers api: lists all sixteen with a selection',
    Array.isArray(provList.providers) && provList.providers.length === 16
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

  // A connected provider CLI (the fake Gemini) can be the prompt generator -
  // the 'auto' chain and a pinned provider both reach it.
  await post('/api/settings', { refineProvider: 'gemini' });
  const refG = await post('/api/refine', { text: 'build a login page', flow: 'task' });
  ok('refine: a connected provider CLI generates the prompt',
    refG.ok && refG.via === 'gemini-cli' && refG.prompt.includes('REFINED_VIA_GEMINI'),
    JSON.stringify(refG).slice(0, 200));
  await post('/api/settings', { refineProvider: 'auto' });

  // usage & cost over HTTP, against the fixture session log.
  if (HAS_SQLITE) {
    const us = await get('/api/usage?month=2026-09');
    ok('usage api: month totals from Devin\'s log',
      us.available === true && Math.abs(us.totals.acu - 1.51) < 1e-9 && us.tasks.length === 3 && us.byFlow[0].runs === 2,
      JSON.stringify({ a: us.available, t: us.totals && us.totals.acu, m: us.message }));
    ok('usage api: dollars come with the rate and how it was verified',
      us.dollars && us.dollars.basis === 'measured' && us.dollars.usdPerAcu === 2 && us.dollars.verified === 5 && us.dollars.source === usagePrices,
      JSON.stringify(us.dollars));
    const usAug = await get('/api/usage?month=2026-08&scope=flowforge');
    ok('usage api: scope filter reaches the server', usAug.totals.acu === 0 && usAug.scope === 'flowforge');
    const est = await post('/api/estimate', { flow: 'task', task: 'add a login page with email validation' });
    const taskStages = JSON.parse(fs.readFileSync(path.join(WORKBENCH, 'flows', 'task.json'), 'utf8')).stages.length;
    ok('usage api: the estimate reads the real flow, skill and role files',
      est.promptTokens > 0 && est.overheadTokens > 1000 && est.stages.length === taskStages
      && est.overhead.some((p) => p.name === 'skill' && p.tokens > 0) && est.overhead.some((p) => p.name.startsWith('agent:')),
      JSON.stringify({ p: est.promptTokens, o: est.overheadTokens, s: est.stages && est.stages.length }));
    ok('usage api: the estimate forecasts from past runs of the flow', est.forecast && est.forecast.runs === 2 && est.forecast.basis === 'this-flow');
    ok('usage api: the estimate breaks the pipeline down stage by stage',
      est.pipeline && est.pipeline.stages.length === taskStages && est.pipeline.happy.tokens > 0 && est.pipeline.happy.acu > 0
      && est.pipeline.orchestrator.calls > 0 && est.pipeline.retryPaths.some((r) => r.from === 'test'));
    const estQ = await post('/api/estimate', { flow: 'task', task: 'x', speed: 'quality' });
    ok('usage api: the speed setting reaches the estimate',
      estQ.pipeline.speed === 'quality' && estQ.pipeline.stages.filter((s) => s.kind !== 'script').every((s) => s.model === 'claude-opus-5-max'));
    ok('usage api: stages on the price list are priced in real dollars',
      est.pipeline.stages.filter((s) => s.kind !== 'script').some((s) => s.basis === 'price-list' && s.usd > 0)
      && est.dollars.usdPerAcu === 2 && est.pipeline.happy.usd > 0, JSON.stringify(est.pipeline.stages.map((s) => [s.model, s.basis])));
    const rep = await post('/api/usage/report', { month: '2026-09', to: 'md' });
    ok('usage api: the monthly report is saved as an artifact',
      rep.ok && rep.markdown.includes('2026-09') && !!rep.saved && fs.existsSync(rep.saved), JSON.stringify({ s: rep.saved, e: rep.error }));
    ok('usage api: the report is in dollars at the verified rate without being told one',
      rep.markdown.includes('| Cost (USD) | $3.02') && rep.markdown.includes('1 ACU = $2') && rep.markdown.includes('verified on 5 of 5'),
      rep.markdown.slice(0, 400));
    const repC = await post('/api/usage/report', { month: '2026-09', to: 'md', usdPerAcu: 1.5 });
    ok('usage api: a contract rate overrides the list price in the report',
      /\| Cost \(USD\) \| \$2\.2[67] \|/.test(repC.markdown) && repC.markdown.includes('contract rate of $1.5'), repC.markdown.slice(0, 400));

    // Every other tool, over HTTP: dollars by tool, the tool filter, and the
    // Tracking switches (dry: nothing on this machine is changed).
    const oct = await get('/api/usage?month=2026-10');
    const tools = (oct.byTool || []).map((x) => x.tool);
    ok('usage api: October adds up every tool\'s records in dollars',
      ['claude', 'codex', 'gemini', 'opencode', 'cline', 'aider', 'cursor', 'copilot'].every((t) => tools.includes(t))
      && oct.totals.usd > 0 && Math.abs(oct.byTool.reduce((a, x) => a + x.usd, 0) - oct.totals.usd) < 1e-9, JSON.stringify(tools));
    ok('usage api: the Tracking list covers every tool, unsupported ones included',
      Array.isArray(oct.tracking) && oct.tracking.length === 13 && oct.tracking.find((x) => x.tool === 'kiro').kind === 'unsupported'
      && oct.tracking.find((x) => x.tool === 'claude').found === true);
    const octClaude = await get('/api/usage?month=2026-10&tool=claude');
    ok('usage api: the tool filter reaches the server', octClaude.byTool.length === 1 && octClaude.byTool[0].tool === 'claude');
    const hooksPath = path.join(toolHome, '.cursor', 'hooks.json');
    const cOn = await post('/api/usage/tracking', { tool: 'cursor', on: true });
    const trk1 = await get('/api/usage/tracking');
    const cOff = await post('/api/usage/tracking', { tool: 'cursor', on: false });
    ok('usage api: the Cursor switch installs and removes the hook in the (test) home',
      cOn.ok && trk1.tracking.find((x) => x.tool === 'cursor').enabled === true && cOff.ok
      && !fs.readFileSync(hooksPath, 'utf8').includes('usage-hook.mjs'), JSON.stringify(cOn));
    const aOn = await post('/api/usage/tracking', { tool: 'aider', on: true });
    const trk2 = await get('/api/usage/tracking');
    await post('/api/usage/tracking', { tool: 'aider', on: false });
    ok('usage api: the Aider switch records its variable (dry run - nothing real changed)',
      aOn.ok && aOn.dry === true && trk2.tracking.find((x) => x.tool === 'aider').enabled === true);
    const bad = await post('/api/usage/tracking', { tool: 'windsurf', on: true });
    ok('usage api: a tool without a recorder is refused', !!bad.error);

    // Recent runs carry their real cost; the canvas prices an unsaved flow.
    fs.writeFileSync(usageRunsFile, JSON.stringify([
      { sessionId: 'chat-1', flow: 'bugfix', task: 'crash on start', exitCode: 0, mode: 'acp', startedAt: '2026-08-20T12:00:00Z', endedAt: '2026-08-20T12:20:00Z' },
      { sessionId: null, flow: 'task', task: 'fix the bug', project: USAGE_P1, exitCode: 2, mode: 'cli', startedAt: '2026-09-12T12:00:30Z', endedAt: '2026-09-12T12:09:30Z' },
    ]));
    const runs = await get('/api/runs?n=5');
    fs.writeFileSync(usageRunsFile, '[]');
    ok('runs api: the last runs come back newest first with their linked cost',
      Array.isArray(runs.runs) && runs.runs.length === 2 && Date.parse(runs.runs[0].startedAt) > Date.parse(runs.runs[1].startedAt)
      && runs.runs.some((r) => typeof r.usd === 'number' && r.usd > 0 && r.acu > 0 && r.tokens > 0 && r.durationSec !== null),
      JSON.stringify(runs.runs.map((r) => [r.flow, r.usd, r.exitCode])));
    const inline = await post('/api/estimate', { flow: 'canvas-x', task: '', flowDef: { stages: [
      { id: 'a', agent: 'coder', model: 'claude-opus-5-high' }, { id: 'b', agent: 'tester', model: 'claude-sonnet-5-high' }] } });
    ok('estimate api: an inline (unsaved canvas) flow is priced stage by stage',
      inline.pipeline.stages.length === 2 && inline.pipeline.stages[0].id === 'a' && inline.pipeline.stages[0].basis === 'price-list'
      && inline.pipeline.happy.usd > 0, JSON.stringify(inline.pipeline.stages.map((s) => [s.id, s.basis])));
    const repHtml = await post('/api/usage/report', { month: '2026-09', to: 'html' });
    ok('usage api: the report converts to another format', repHtml.ok && !!repHtml.out && fs.existsSync(repHtml.out), JSON.stringify(repHtml).slice(0, 160));
    const repBad = await post('/api/usage/report', { month: '2026-09', to: 'exe' });
    ok('usage api: an unknown report format is refused', !!repBad.error);
  } else {
    const us = await get('/api/usage');
    ok('usage api: reports the log as unavailable on this Node', us.available === false && !!us.message);
  }

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
  // Resume: refused without an interrupted state, otherwise a /flow-resume run.
  const stateFile = path.join(scratch, '.workbench', 'state.json');
  const stateBefore = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
  fs.writeFileSync(stateFile, JSON.stringify({ flow: 'task', task: 'x', status: 'done', stages: [] }));
  const noResume = await post('/api/run', { flow: 'resume', gates: 'dashboard' });
  fs.writeFileSync(stateFile, JSON.stringify({ flow: 'task', task: 'x', status: 'stopped', currentStage: 'think', stages: [{ id: 'think', status: 'waiting_gate' }] }));
  const resumed = await post('/api/run', { flow: 'resume', gates: 'dashboard', speed: 'fast' });
  let resumeRun = null;
  for (let i = 0; i < 40; i++) { await sleep(250); resumeRun = await get('/api/run'); if (!resumeRun.active) break; }
  ok('run: resume is refused when the flow is done, and otherwise invokes /flow-resume headless',
    noResume.error === 'nothing_to_resume' && resumed.ok === true
    && resumeRun.lines.some((l) => l.includes('/flow-resume --gates=dashboard --speed=fast --headless=cli')), JSON.stringify({ noResume, cmd: resumed.cmd }));
  if (stateBefore === null) fs.rmSync(stateFile, { force: true }); else fs.writeFileSync(stateFile, stateBefore);
  ok('run: understand prompt shape', finished.lines.some((l) => l.includes('/understand --gates=terminal')));
  const rstop409 = await post('/api/run/stop', {});
  ok('run: stop without active run rejected', !!rstop409.error);
  let runsLog = [];
  for (let i = 0; i < 20 && !runsLog.some((r) => r.flow === 'understand'); i++) {
    await sleep(150);
    try { runsLog = JSON.parse(fs.readFileSync(usageRunsFile, 'utf8')); } catch { runsLog = []; }
  }
  ok('usage: every finished run lands in the run log (and only in the test\'s own file)',
    runsLog.some((r) => r.flow === 'understand' && r.mode === 'cli' && r.exitCode === 0 && r.startedAt && r.endedAt),
    JSON.stringify(runsLog.slice(-2)));

  // Queue + parallel projects: two tasks for the scratch project and one for
  // another folder. The other folder runs at once (parallel), the second
  // scratch task waits for the first (one run per project).
  const otherProj = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-other-'));
  const qa = await post('/api/queue', { items: [
    { project: scratch, flow: 'task', task: 'queued one', gates: 'auto' },
    { project: scratch, flow: 'task', task: 'queued two', gates: 'auto', speed: 'fast' },
    { project: otherProj, flow: 'task', task: 'other project', gates: 'auto' },
  ] });
  ok('queue api: several tasks are added at once', qa.ok && qa.added.length === 3, JSON.stringify(qa));
  let b1 = null;
  for (let i = 0; i < 20; i++) { await sleep(250); b1 = await get('/api/runs/board'); if (b1.active.length === 2) break; }
  const projs = b1.active.map((r) => path.resolve(r.project).toLowerCase()).sort();
  ok('board api: two projects run in parallel, the busy project\'s second task waits',
    b1.active.length === 2 && projs.includes(path.resolve(otherProj).toLowerCase()) && projs.includes(path.resolve(scratch).toLowerCase())
    && b1.queue.filter((q) => q.status === 'queued').length === 1 && b1.queue.find((q) => q.status === 'queued').task === 'queued two'
    && b1.maxParallel === 2, JSON.stringify({ a: b1.active.map((r) => r.task), q: b1.queue.map((q) => [q.task, q.status]) }));
  ok('board api: an active run carries progress fields and the live cost slot',
    b1.active.every((r) => 'state' in r && 'usage' in r && r.active === true && r.id));
  const enq = await post('/api/run', { flow: 'task', task: 'third via run button', gates: 'auto', enqueue: true });
  ok('run api: while the project is busy, enqueue=true lines the task up instead of a 409', enq.ok && enq.mode === 'queue' && enq.position === 2, JSON.stringify(enq));
  const stBoard = await get('/api/state');
  ok('state api: the board summary reaches every tab', stBoard.board && stBoard.board.active === 2 && stBoard.board.here === true && stBoard.board.queued === 2,
    JSON.stringify(stBoard.board));
  let b2 = null;
  for (let i = 0; i < 60; i++) { await sleep(400); b2 = await get('/api/runs/board'); if (!b2.active.length && !b2.queue.length) break; }
  const hist = b2.history.map((q) => [q.task, q.status]);
  ok('board api: the queue drains on its own, every item ends up done in history',
    b2.active.length === 0 && b2.queue.length === 0 && ['queued one', 'queued two', 'other project', 'third via run button'].every((tk) => hist.some((h) => h[0] === tk && h[1] === 'done')),
    JSON.stringify(hist));
  const sAdd = await post('/api/schedules', { project: scratch, flow: 'quality', task: 'nightly checks', gates: 'auto', repeat: { kind: 'daily', at: '03:00' } });
  ok('schedules api: a daily job is created with its next time', sAdd.ok && sAdd.schedule.enabled && typeof sAdd.schedule.nextAt === 'number' && sAdd.schedule.nextAt > Date.now());
  const sNow = await post('/api/schedules/run-now', { id: sAdd.schedule.id });
  const sOff = await post('/api/schedules', { id: sAdd.schedule.id, enabled: false });
  const b3 = await get('/api/runs/board');
  ok('schedules api: run-now queues the job, pause keeps it listed but idle',
    sNow.ok && sNow.item.scheduleId === sAdd.schedule.id && sOff.schedule.enabled === false && b3.schedules.length === 1
    && [...b3.queue, ...b3.history].some((q) => q.scheduleId === sAdd.schedule.id), JSON.stringify({ q: b3.queue.length }));
  for (let i = 0; i < 40; i++) { const b = await get('/api/runs/board'); if (!b.active.length && !b.queue.length) break; await sleep(400); }
  const sDel = await fetch(`http://127.0.0.1:${PORT}/api/schedules?id=${sAdd.schedule.id}`, { method: 'DELETE' }).then((r) => r.json());
  const badRep = await post('/api/schedules', { project: scratch, flow: 'task', task: 'x', repeat: { kind: 'daily', at: '99:99' } });
  ok('schedules api: delete works and an impossible repeat is refused', sDel.ok && !!badRep.error && (await get('/api/runs/board')).schedules.length === 0);
  ok('queue api: the queue file is the test\'s own, not the install\'s', fs.existsSync(path.join(scratch, 'queue.json')));

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
    "else if(m.method==='authenticate'){reply({jsonrpc:'2.0',id:m.id,result:{}});}",
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
  ok('acp: session created + prompt completed', result.sessionId === 'fake-session' && result.stopReason === 'end_turn');
  ok('acp: thought chunk streamed', updates.some((u) => u.sessionUpdate === 'agent_thought_chunk' && u.content.text === 'thinking...'));
  ok('acp: tool call streamed', updates.some((u) => u.sessionUpdate === 'tool_call' && u.title === 'Read file'));
  ok('acp: message chunk streamed', updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && u.content.text === 'OK'));
  // keepAlive: the session outlives the first turn and takes follow-ups.
  const live = startAcp({ cwd: scratch4, prompt: 'first', cliPath: fakeAcp, timeoutMs: 20000, keepAlive: true });
  const first = await live.promise;
  await sleep(150);
  const alive = live.proc.exitCode === null;
  const second = await live.prompt('second turn');
  live.close();
  await sleep(300);
  let afterClose = 'no-error';
  try { await live.prompt('third'); } catch (e) { afterClose = e.message; }
  ok('acp: keepAlive keeps the session for follow-up turns and close() ends it',
    first.stopReason === 'end_turn' && alive && second === 'end_turn' && /closed|exited/.test(afterClose), JSON.stringify({ alive, second, afterClose }));
  await sleep(400); // let the fake agent process exit before removing its dir
  try { fs.rmSync(scratch4, { recursive: true, force: true }); } catch {}
}

// ---------- 4b. gates over ACP: the agent stops at a gate, the decision resumes it ----------
console.log('# acp gate checks');
{
  const scratch5 = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test5-'));
  fs.mkdirSync(path.join(scratch5, '.workbench'), { recursive: true });
  // A fake `devin acp` orchestrator: on the first prompt it parks the flow at
  // the "think" gate (state.json only - it "forgets" commands.json, which the
  // server must then write). The GATE_DECISION message completes the flow.
  // A task named "nudge demo" instead stops with the flow still running once.
  const fakeAcp5 = path.join(scratch5, 'fake-acp.mjs');
  fs.writeFileSync(fakeAcp5, [
    "import fs from 'node:fs'; import path from 'node:path';",
    "const st = path.join(process.cwd(), '.workbench', 'state.json');",
    "const write = (o) => fs.writeFileSync(st, JSON.stringify(o));",
    "let buf=''; let turn = 0; let task = '';",
    "process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){",
    'const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;',
    'const m=JSON.parse(line);',
    "const reply=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');",
    "if(m.method==='initialize'){reply({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});}",
    "else if(m.method==='authenticate'){reply({jsonrpc:'2.0',id:m.id,result:{}});}",
    "else if(m.method==='session/new'){reply({jsonrpc:'2.0',id:m.id,result:{sessionId:'gate-session'}});}",
    "else if(m.method==='session/prompt'){",
    "const text=m.params.prompt.map((p)=>p.text||'').join(' '); turn++;",
    "const note=(u)=>reply({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:u}});",
    "if(turn===1){ task=(text.match(/\"([^\"]*)\"/)||[])[1]||''; }",
    "const base={flow:'task',task,taskRaw:task,project:process.cwd(),stages:[{id:'think',title:'Think',status:'waiting_gate'},{id:'code',title:'Code',status:'pending'}],log:[]};",
    "if(task==='nudge demo'){",
    "  if(turn===1){ write({...base,status:'running',currentStage:'think',stages:[{id:'think',status:'running'}]}); note({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'oops, stopping early'}}); }",
    "  else if(/Your turn ended/.test(text)){ write({...base,status:'done',currentStage:null}); note({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'resumed and finished'}}); }",
    "} else if(turn===1){ write({...base,status:'waiting_gate',currentStage:'think'}); note({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'GATE_WAIT think'}}); }",
    "else if(/GATE_DECISION think approve/.test(text)){ write({...base,status:'done',currentStage:null,stages:[{id:'think',status:'done'},{id:'code',status:'done'}],note:text}); note({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'approved, finishing: '+text.split('\\n')[1]}}); }",
    "reply({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});}",
    '}});',
  ].join('\n'));
  const PORT5 = PORT + 2;
  const base5 = `http://127.0.0.1:${PORT5}`;
  const g5 = (p) => fetch(base5 + p).then(j);
  const p5 = (p, b) => fetch(base5 + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(j);
  const flowsDir5 = path.join(scratch5, 'wb-flows');
  const env5 = { ...process.env, DEVIN_CLI: fakeAcp5, WINDSURF_API_KEY: 'test-key', FF_REGISTRY: path.join(scratch5, 'projects.test.json'),
    FF_QUEUE_FILE: path.join(scratch5, 'q.json'), FF_SCHEDULES_FILE: path.join(scratch5, 's.json'), FF_USAGE_RUNS: path.join(scratch5, 'runs.json'),
    FF_DEVIN_SESSIONS_DB: path.join(scratch5, 'none.db'), FF_TOOL_HOME: scratch5, FF_USAGE_DIR: path.join(scratch5, 'usage') };
  delete env5.FF_NO_ACP;
  void flowsDir5;
  const server5 = spawn(process.execPath, [path.join(DASHBOARD, 'server.mjs'), scratch5, String(PORT5)], { stdio: 'pipe', env: env5 });
  try {
    await sleep(900);
    const started = await p5('/api/run', { flow: 'task', task: 'gate demo', gates: 'dashboard' });
    ok('acp gate: the run starts over ACP with the headless flag', started.ok && started.mode === 'acp' && /--headless=acp/.test(started.cmd), JSON.stringify(started));
    let st5 = null;
    for (let i = 0; i < 30; i++) { await sleep(200); st5 = await g5('/api/state'); if (st5.gate && st5.gate.stage === 'think') break; }
    const r5 = await g5('/api/run');
    ok('acp gate: the agent stopped at the gate, the run stays active and the dashboard shows the question',
      st5.gate && st5.gate.stage === 'think' && st5.gate.question.length > 10 && r5.active === true
      && r5.lines.some((l) => l.includes('[gate] waiting for your decision on "think"')), JSON.stringify({ g: st5.gate, a: r5.active }));
    const dec = await p5('/api/command', { stage: 'think', decision: 'approve', note: 'go ahead' });
    let done5 = null;
    for (let i = 0; i < 40; i++) { await sleep(200); done5 = await g5('/api/run'); if (!done5.active) break; }
    const st6 = await g5('/api/state');
    ok('acp gate: the decision goes back to the same session and the flow finishes',
      dec.ok && dec.via === 'acp' && done5.active === false && done5.exitCode === 0
      && done5.lines.some((l) => l.includes('[gate] approve: think - go ahead')) && done5.lines.some((l) => l.includes('approved, finishing: NOTE: go ahead'))
      && !st6.gate, JSON.stringify({ dec, exit: done5.exitCode, tail: done5.lines.slice(-4) }));
    const nudge = await p5('/api/run', { flow: 'task', task: 'nudge demo', gates: 'auto' });
    let done6 = null;
    for (let i = 0; i < 40; i++) { await sleep(200); done6 = await g5('/api/run'); if (!done6.active) break; }
    ok('acp gate: an agent that stops mid-flow is nudged once and completes',
      nudge.ok && done6.active === false && done6.exitCode === 0 && done6.lines.some((l) => l.includes('asking it to continue'))
      && done6.lines.some((l) => l.includes('resumed and finished')), JSON.stringify(done6.lines.slice(-5)));
  } finally {
    server5.kill();
    await sleep(300);
    try { fs.rmSync(scratch5, { recursive: true, force: true }); } catch {}
  }
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
