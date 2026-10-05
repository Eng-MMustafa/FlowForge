// run-flow.mjs - `ff run <flow> "<task>"`: start a pipeline from the terminal.
//
//   ff run task "add rate limiting to /api/upload" --size=small
//   ff run bugfix "uploads over 5MB fail" --gates=ai --speed=fast
//   ff run understand
//
// When the dashboard is up, the run is handed to it (same queue, live view,
// gates on the dashboard) and this command returns at once with the URL.
// Otherwise - or with --direct - it drives the Devin CLI itself in this
// terminal; nobody can answer a gate in a headless CLI run, so gates default
// to `auto` there (use --gates=ai for an AI reviewer at every gate).
//
// Flags: --gates=auto|ai|dashboard|terminal  --speed=fast|balanced|quality
//        --size=auto|tiny|small|full  --direct  --port=4820  --project=DIR
//        --permission=dangerous|accept-edits|smart|normal
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { devinCliCandidates, whichSync } from './lib/platform.mjs';
import { readState, summary } from './lib/state.mjs';

const WORKBENCH = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => { const hit = argv.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(n.length + 3) : d; };
const words = argv.filter((a) => !a.startsWith('--'));
const die = (m) => { console.error(`ff run: ${m}`); process.exit(1); };

const GATES = ['auto', 'ai', 'dashboard', 'terminal'];
const SPEEDS = ['fast', 'balanced', 'quality'];
const SIZES = ['auto', 'tiny', 'small', 'full'];

const flow = words[0];
const task = words.slice(1).join(' ').replace(/"/g, "'").trim();
const project = path.resolve(value('project', process.cwd()));
const port = Number(value('port', 4820)) || 4820;
const speed = value('speed', '');
const size = value('size', 'auto');

if (!flow) die('usage: ff run <flow> "<task>" [--gates=auto|ai] [--speed=fast|balanced|quality] [--size=auto|tiny|small|full] [--direct]');
if (!/^[\w.-]+$/.test(flow)) die(`bad flow name: ${flow}`);
const flowFile = path.join(WORKBENCH, 'flows', `${flow}.json`);
if (flow !== 'resume' && !fs.existsSync(flowFile)) {
  const have = fs.readdirSync(path.join(WORKBENCH, 'flows')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  die(`no flow "${flow}" - have: ${have.join(', ')}`);
}
if (flow !== 'understand' && flow !== 'resume' && !task) die(`flow "${flow}" needs a task: ff run ${flow} "what to do"`);
if (speed && !SPEEDS.includes(speed)) die(`--speed must be one of ${SPEEDS.join('|')}`);
if (!SIZES.includes(size)) die(`--size must be one of ${SIZES.join('|')}`);
if (!fs.existsSync(project)) die(`project not found: ${project}`);

// 1. Dashboard up? Hand the run over - it owns queueing, live state and gates.
async function viaDashboard() {
  const base = `http://127.0.0.1:${port}`;
  try {
    const h = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (!h.ok) return false;
  } catch { return false; }
  const gates = GATES.includes(value('gates', '')) ? value('gates', '') : 'dashboard';
  const res = await fetch(`${base}/api/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, flow, task, gates, speed: speed || 'flow', size, permissionMode: value('permission', 'dangerous'), enqueue: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(`dashboard refused the run: ${body.error || res.status}`);
  console.log(`FlowForge: ${flow} ${body.mode === 'queue' ? `queued (position ${body.position || 1})` : `started (${body.mode})`} on ${project}`);
  console.log(`  watch and approve gates: ${base}/#overview`);
  return true;
}

// 2. No dashboard: drive the Devin CLI here.
function devinCli() {
  if (process.env.DEVIN_CLI) return process.env.DEVIN_CLI;
  return whichSync('devin') || devinCliCandidates().find((p) => fs.existsSync(p)) || null;
}

function direct() {
  const cli = devinCli();
  if (!cli) die('Devin CLI not found - install Devin, or start the dashboard (ff) and run from there. Check with: ff doctor');
  const gates = GATES.includes(value('gates', '')) && value('gates', '') !== 'terminal' && value('gates', '') !== 'dashboard'
    ? value('gates', '') : 'auto';
  const extra = `${speed ? ` --speed=${speed}` : ''}${size !== 'auto' && flow !== 'resume' ? ` --size=${size}` : ''}`;
  const prompt = flow === 'resume' ? `/flow-resume --gates=${gates}${speed ? ` --speed=${speed}` : ''} --headless=cli`
    : flow === 'understand' && !task ? `/understand --gates=${gates}${extra} --headless=cli`
      : `/flow ${flow} "${task}" --gates=${gates}${extra} --headless=cli`;
  const args = ['--permission-mode', value('permission', 'dangerous'), '--respect-workspace-trust', 'false', '-p', prompt];
  const viaNode = /\.(mjs|js)$/i.test(cli);
  console.log(`FlowForge: ${prompt}`);
  console.log(`  project: ${project}   (gates: ${gates}; Ctrl+C stops)`);
  const child = spawn(viaNode ? process.execPath : cli, viaNode ? [cli, ...args] : args, { cwd: project, stdio: 'inherit' });
  child.on('error', (e) => die(`could not start the Devin CLI: ${e.message}`));
  child.on('exit', (code) => {
    try { console.log(`\n${summary(readState(project))}`); } catch { /* no state written */ }
    process.exit(code ?? 1);
  });
}

if (flag('direct') || !(await viaDashboard())) direct();
