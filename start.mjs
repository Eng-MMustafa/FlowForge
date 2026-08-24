// start.mjs - The single command: `node start.mjs`
// Installs FlowForge into Devin if that was never done (or the workbench moved),
// starts the dashboard, and opens it in the browser. Everything else - picking
// the project, writing the task, running flows, approving gates - happens on
// the dashboard itself. Ctrl+C stops the server.
//
// Usage:
//   node start.mjs [project path] [--port=4820] [--no-open] [--check]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  agentConfigDir, agentConfigCandidates, openUrlCommand, samePath, stateDir,
} from './scripts/lib/platform.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const DEVIN = agentConfigDir() || null;
const LOCATOR = DEVIN ? path.join(DEVIN, 'flowforge.json') : null;

const argv = process.argv.slice(2);
const flag = (name) => argv.some((a) => a === `--${name}`);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = Number(value('port', 4820)) || 4820;
const projectArg = argv.find((a) => !a.startsWith('--')) || null;
const BASE = `http://127.0.0.1:${PORT}`;

// A junction is only useful while it still points at THIS clone - a moved or
// renamed folder leaves a link that resolves nowhere.
function linkOk(name) {
  const link = DEVIN && path.join(DEVIN, name);
  if (!link || !fs.existsSync(link)) return false;
  try { return fs.realpathSync(link) === fs.realpathSync(path.join(REPO, name)); } catch { return false; }
}

function locatorOk() {
  if (!LOCATOR || !fs.existsSync(LOCATOR)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(LOCATOR, 'utf8'));
    return samePath(cfg.workbench || '', REPO);
  } catch { return false; }
}

function status() {
  return { repo: REPO, devinConfig: DEVIN, locator: locatorOk(), skills: linkOk('skills'), agents: linkOk('agents') };
}

async function serverAlive() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

function openBrowser(url) {
  if (flag('no-open')) return;
  try {
    const { cmd, args } = openUrlCommand(url);
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* the URL is printed anyway */ }
}

const st = status();
if (flag('check')) {
  console.log(JSON.stringify({ ...st, ready: st.locator && st.skills && st.agents }, null, 2));
  process.exit(0);
}

console.log('FlowForge');
console.log(`  workbench: ${REPO}`);

// No Devin on this machine is NOT a reason to refuse: the dashboard, the flow
// editor, the artifacts and the export all work without it. Only the chat
// skills need the wiring, so that part is skipped with a clear note.
const devinPresent = !!DEVIN && fs.existsSync(DEVIN);
if (!devinPresent) {
  console.log('  Devin config not found - starting the dashboard anyway.');
  console.log(`    looked in: ${agentConfigCandidates().join(', ')}`);
  console.log('    install Devin (or set DEVIN_CONFIG_DIR), then run: node install.mjs');
} else if (!st.locator || !st.skills || !st.agents) {
  console.log('  installing into Devin (first run or the folder moved)...');
  const r = spawnSync(process.execPath, [path.join(REPO, 'install.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) console.error('  wiring into Devin failed - the dashboard still starts; see the error above');
  else console.log('  NOTE: start a NEW Devin session so it picks up the skills.');
} else {
  console.log('  skills + agents: installed ✓');
}

if (await serverAlive()) {
  console.log(`  dashboard already running -> ${BASE}`);
  openBrowser(BASE);
  process.exit(0);
}

// A path the user mistyped must be one clear line, not twenty restarts of a
// server that cannot possibly succeed.
if (projectArg) {
  const p = path.resolve(projectArg);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    console.error(`  project folder not found: ${p}`);
    console.error('  pass an existing folder, or none at all to use the current one.');
    process.exit(1);
  }
}

// The server takes [project, port] positionally - the port MUST be passed or a
// --port= flag would only change what this launcher polls, not what binds.
const serverArgs = [
  path.join(REPO, 'dashboard', 'server.mjs'),
  projectArg ? path.resolve(projectArg) : '',
  String(PORT),
];

// A flow agent that force-kills node processes (or any crash) must not take the
// user's control surface down with it: keep a log and bring the server back.
// Next to the code when that is writable, in the per-user state directory when
// the install belongs to someone else (a root-owned global install).
const LOG_FILE = path.join(stateDir(path.join(REPO, 'dashboard')), 'server.log');
const MAX_RESTARTS = 20;
let restarts = 0;
let stopping = false;
let server = null;

function launchServer() {
  const log = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  log.write(`\n=== server start ${new Date().toISOString()} ===\n`);
  server = spawn(process.execPath, serverArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of ['stdout', 'stderr']) {
    server[stream].pipe(process[stream === 'stdout' ? 'stdout' : 'stderr']);
    server[stream].pipe(log, { end: false });
  }
  server.on('exit', (code, signal) => {
    log.write(`=== server exit code=${code} signal=${signal} ${new Date().toISOString()} ===\n`);
    log.end();
    if (stopping) { process.exit(code === null ? 0 : code); return; }
    // Exit 3 = the port is taken. Restarting cannot fix that, and the server
    // already printed what to do.
    if (code === 3) process.exit(3);
    if (restarts >= MAX_RESTARTS) { console.error(`  server keeps exiting (${restarts} restarts) - see ${LOG_FILE}`); process.exit(1); }
    restarts++;
    console.error(`  server exited (code=${code} signal=${signal}) - restarting #${restarts}, log: ${LOG_FILE}`);
    setTimeout(launchServer, 1000);
  });
}

launchServer();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; try { server.kill(); } catch {} });

// Open the browser only once the server actually answers.
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await serverAlive()) {
    console.log(flag('no-open') ? `  ready -> ${BASE}` : `  opening ${BASE}`);
    openBrowser(BASE);
    break;
  }
}
