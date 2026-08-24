// get.mjs - one-command installer for FlowForge.
//
//   Windows:  iwr -useb https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/get.mjs -o "$env:TEMP\ff.mjs"; node "$env:TEMP\ff.mjs"
//   macOS/Linux:  curl -fsSL https://raw.githubusercontent.com/Eng-MMustafa/FlowForge/main/get.mjs -o /tmp/ff.mjs && node /tmp/ff.mjs
//
// Downloads (or updates) the workbench, wires it into Devin when Devin is
// present, and opens the dashboard. Node builtins only - no npm, no shell
// script file, nothing to trust beyond this readable file. This file is
// fetched and run ON ITS OWN, so it must never import from the repo.
//
// Usage: node get.mjs [target dir] [--branch=main] [--no-start] [--no-open]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const REPO = 'Eng-MMustafa/FlowForge';
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const BRANCH = value('branch', 'main');
// Where a fresh copy lands when the user names no folder (mirrors
// defaultInstallDir() in scripts/lib/platform.mjs - kept inline on purpose).
const defaultDir = () => {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'FlowForge');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'FlowForge');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'FlowForge');
};
const TARGET = path.resolve(argv.find((a) => !a.startsWith('--')) || defaultDir());

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const info = (m) => console.log(`  \x1b[36m..\x1b[0m    ${m}`);
const warn = (m) => console.log(`  \x1b[33mwarn\x1b[0m  ${m}`);
const die = (m) => { console.error(`  \x1b[31mfail\x1b[0m  ${m}`); process.exit(1); };

const have = (cmd) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd],
    { stdio: 'ignore', shell: false });
  return r.status === 0;
};
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });

console.log('');
console.log('  \x1b[1mFlowForge\x1b[0m - staged AI engineering pipelines');
console.log('');

// 1. Node version. The dashboard and scripts assume modern builtins.
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) die(`Node 18+ required, found ${process.versions.node} - https://nodejs.org`);
ok(`node ${process.versions.node}`);

// 2. Fetch or update the workbench.
const isClone = fs.existsSync(path.join(TARGET, '.git'));
const isPopulated = fs.existsSync(path.join(TARGET, 'start.mjs'));

async function download() {
  const url = `https://codeload.github.com/${REPO}/zip/refs/heads/${BRANCH}`;
  const tmpZip = path.join(os.tmpdir(), `flowforge-${Date.now()}.zip`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-x-'));
  info(`downloading ${BRANCH}.zip`);
  const res = await fetch(url);
  if (!res.ok) die(`download failed (HTTP ${res.status}) - is the branch "${BRANCH}" right?`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpZip));
  // Windows 10+ and macOS ship a tar that reads zip archives; GNU tar on Linux
  // does not, so `unzip` is the fallback there.
  const extracted = (have('tar') && run('tar', ['-xf', tmpZip, '-C', tmpDir]).status === 0)
    || (have('unzip') && run('unzip', ['-q', tmpZip, '-d', tmpDir]).status === 0);
  if (!extracted) die('could not extract the archive - install Git (or unzip) and retry');
  const inner = path.join(tmpDir, fs.readdirSync(tmpDir)[0]);
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.cpSync(inner, TARGET, { recursive: true, force: true });
  fs.rmSync(tmpZip, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (isClone) {
  info('existing clone found - updating');
  if (run('git', ['pull', '--ff-only'], TARGET).status === 0) ok(`updated  ${TARGET}`);
  else warn('git pull failed (local changes?) - keeping what is on disk');
} else if (isPopulated) {
  info('existing copy found - refreshing files');
  await download();
  ok(`updated  ${TARGET}`);
} else if (have('git')) {
  info(`cloning into ${TARGET}`);
  if (run('git', ['clone', '--depth', '1', '--branch', BRANCH,
    `https://github.com/${REPO}.git`, TARGET]).status !== 0) die('git clone failed');
  ok(`cloned   ${TARGET}`);
} else {
  await download();
  ok(`installed ${TARGET}`);
}

// 3. Wire the skills/agents into Devin. install.mjs knows where Devin's config
// lives on each platform, so it - not this file - decides whether that is
// possible. The dashboard is fully usable without it: a miss is a warning.
{
  const r = spawnSync(process.execPath, [path.join(TARGET, 'install.mjs')],
    { cwd: TARGET, encoding: 'utf8' });
  if (r.status === 0) ok('skills and agents wired into Devin');
  else if (/not found/i.test(`${r.stdout || ''}${r.stderr || ''}`)) {
    warn('Devin was not found - the dashboard still works; run "node install.mjs" after installing Devin');
  } else warn('wiring into Devin failed - run "node install.mjs" inside the folder to see why');
}

console.log('');
console.log('  Installed at:  ' + TARGET);
console.log('  Start later:   node "' + path.join(TARGET, 'start.mjs') + '"');
console.log('  Uninstall:     node "' + path.join(TARGET, 'uninstall.mjs') + '"');
console.log('');

// 4. Launch the dashboard on whatever project the user is standing in.
if (flag('no-start')) process.exit(0);
const args = [path.join(TARGET, 'start.mjs')];
const cwd = process.cwd();
if (cwd !== TARGET && fs.existsSync(cwd)) args.push(cwd);
if (flag('no-open')) args.push('--no-open');
info('starting the dashboard');
const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
