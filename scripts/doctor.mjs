// doctor.mjs - `ff doctor`: check every moving part of a FlowForge install and
// say exactly what to do about each problem. `--fix` repairs what can be
// repaired here (re-runs the wiring) and checks again.
//
//   ff doctor            full check (includes the Devin CLI login probe)
//   ff doctor --quick    skip the slow probes (CLI version/login, dashboard)
//   ff doctor --fix      re-wire skills/agents when they are wrong, then re-check
//   ff doctor --json     machine-readable report
// Exit: 0 when nothing failed (warnings allowed), 1 otherwise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentConfigDir, agentConfigCandidates, devinCliCandidates, whichSync, samePath } from './lib/platform.mjs';
import { initState, setStage, bumpLoop, writeState, readState, sizeSkips } from './lib/state.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const FIX = argv.includes('--fix');
const JSON_OUT = argv.includes('--json');
const PORT = Number((argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || 4820;

const results = [];
const add = (status, name, detail = '', fix = '') => results.push({ status, name, detail, fix });
const frontmatter = (src) => {
  const m = String(src).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) { const kv = line.match(/^([\w-]+):\s*(.*)$/); if (kv) out[kv[1]] = kv[2].trim(); }
  return out;
};
const run = (cmd, args, timeout) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ err, out: `${stdout || ''}${stderr || ''}` }));
});

async function check() {
  results.length = 0;
  // 1. Runtime
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) add('fail', 'Node.js', process.versions.node, 'install Node 20+ from https://nodejs.org');
  else if (major < 22) add('warn', 'Node.js', `${process.versions.node} (22.13+ unlocks exact usage numbers)`, 'upgrade Node when convenient');
  else add('ok', 'Node.js', process.versions.node);

  // 2. Devin wiring
  const devin = agentConfigDir();
  const devinOk = !!devin && fs.existsSync(devin);
  if (!devinOk) add('fail', 'Devin config', `not found (looked in ${agentConfigCandidates().join(', ')})`, 'install Devin, or set DEVIN_CONFIG_DIR');
  else add('ok', 'Devin config', devin);
  if (devinOk) {
    const loc = path.join(devin, 'flowforge.json');
    let locOk = false;
    try { locOk = samePath(JSON.parse(fs.readFileSync(loc, 'utf8')).workbench || '', ROOT); } catch {}
    add(locOk ? 'ok' : 'fail', 'Locator', locOk ? loc : `${loc} missing or points elsewhere`, 'ff doctor --fix  (or: ff install)');
    for (const kind of ['skills', 'agents']) {
      const link = path.join(devin, kind);
      let ok = false;
      try { ok = fs.realpathSync(link) === fs.realpathSync(path.join(ROOT, kind)); } catch {}
      if (!ok && fs.existsSync(link)) {
        // A real folder with per-item links (install.mjs's fallback) also counts.
        try { ok = fs.readdirSync(path.join(ROOT, kind)).every((n) => fs.existsSync(path.join(link, n))); } catch {}
      }
      add(ok ? 'ok' : 'fail', `Link: ${kind}`, ok ? `${link} -> ${path.join(ROOT, kind)}` : `${link} is missing or stale`, 'ff doctor --fix');
    }
  }

  // 3. Content integrity: skills, agents, flows
  const skills = fs.readdirSync(path.join(ROOT, 'skills')).filter((n) => fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md')));
  const badSkills = skills.filter((n) => { const fm = frontmatter(fs.readFileSync(path.join(ROOT, 'skills', n, 'SKILL.md'), 'utf8')); return !fm || !fm.name; });
  add(badSkills.length ? 'fail' : 'ok', 'Skills', badSkills.length ? `bad front-matter: ${badSkills.join(', ')}` : `${skills.length} valid (${skills.join(', ')})`, 'fix the SKILL.md header (--- name: ... ---)');
  const agents = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md'));
  const badAgents = agents.filter((f) => { const fm = frontmatter(fs.readFileSync(path.join(ROOT, 'agents', f), 'utf8')); return !fm || !fm.name || !fm.model; });
  add(badAgents.length ? 'fail' : 'ok', 'Agent profiles', badAgents.length ? `missing name/model: ${badAgents.join(', ')}` : `${agents.length} valid`, 'every agent .md needs name: and model: in its header');
  const agentNames = new Set(agents.map((f) => f.slice(0, -3)));
  const flowProblems = [];
  const flows = fs.readdirSync(path.join(ROOT, 'flows')).filter((f) => f.endsWith('.json'));
  for (const f of flows) {
    let flow;
    try { flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows', f), 'utf8')); } catch (e) { flowProblems.push(`${f}: invalid JSON (${e.message})`); continue; }
    const ids = new Set((flow.stages || []).map((s) => s.id));
    for (const s of flow.stages || []) {
      if (s.agent && !agentNames.has(s.agent)) flowProblems.push(`${f}/${s.id}: no profile "${s.agent}"`);
      if (s.onFail && !ids.has(s.onFail)) flowProblems.push(`${f}/${s.id}: onFail -> missing "${s.onFail}"`);
      for (const p of s.pre || []) if (!fs.existsSync(path.join(ROOT, p))) flowProblems.push(`${f}/${s.id}: missing script ${p}`);
    }
    for (const [size, spec] of Object.entries(flow.sizes || {})) {
      const unknown = ((spec && spec.skip) || []).filter((id) => !ids.has(id));
      if (unknown.length) flowProblems.push(`${f}: sizes.${size} skips unknown ${unknown.join(',')}`);
      const refused = ((spec && spec.skip) || []).filter((id) => ids.has(id) && !sizeSkips(flow, size).includes(id));
      if (refused.length) flowProblems.push(`${f}: sizes.${size} cannot skip judged stage ${refused.join(',')}`);
    }
  }
  add(flowProblems.length ? 'fail' : 'ok', 'Flows', flowProblems.length ? flowProblems.slice(0, 6).join(' | ') : `${flows.length} valid`, 'fix the flow file (or delete a broken custom flow)');

  // 4. State engine self-test (temp project, removed afterwards)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-doctor-'));
  try {
    const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows', 'task.json'), 'utf8'));
    const st = initState(flow, { task: 'doctor self-test', project: tmp, size: 'tiny' });
    setStage(st, 'code', 'running'); setStage(st, 'code', 'done'); bumpLoop(st, 'test');
    writeState(tmp, st);
    const back = readState(tmp);
    const okEngine = back.stages.find((s) => s.id === 'code').status === 'done' && back.loops.test === 1;
    add(okEngine ? 'ok' : 'fail', 'State engine', okEngine ? 'atomic write + read-back verified' : 'read-back mismatch', 'reinstall FlowForge (files may be damaged)');
  } catch (e) {
    add('fail', 'State engine', e.message, 'reinstall FlowForge (files may be damaged)');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // 5. Writable install (dashboard keeps local state next to the code)
  try {
    const probe = path.join(ROOT, 'dashboard', `.ff-doctor-${process.pid}`);
    fs.writeFileSync(probe, 'x'); fs.rmSync(probe);
    add('ok', 'Install folder', `${ROOT} (writable)`);
  } catch { add('warn', 'Install folder', `${ROOT} is read-only - local state goes to the per-user folder`, ''); }

  if (QUICK) return;

  // 6. Devin CLI: present, runnable, logged in
  const cli = process.env.DEVIN_CLI || whichSync('devin') || devinCliCandidates().find((p) => fs.existsSync(p));
  if (!cli) add('warn', 'Devin CLI', 'not found - runs only work through an open Devin session (/flow-daemon)', 'install Devin, or put devin on PATH');
  else {
    const v = await run(cli, ['--version'], 15000);
    if (v.err) add('fail', 'Devin CLI', `${cli} does not run: ${v.err.message.slice(0, 80)}`, 'reinstall Devin');
    else {
      add('ok', 'Devin CLI', `${cli} (${v.out.trim().split(/\r?\n/)[0].slice(0, 60)})`);
      const a = await run(cli, ['auth', 'status'], 20000);
      const loggedIn = !a.err && !/not logged in|logged out|no credentials/i.test(a.out);
      // The dashboard prefers ACP with the stored editor key, which works even
      // when the CLI's own login is absent. Only the key's PRESENCE is read.
      const { readStoredKey } = await import('../dashboard/acp-client.mjs');
      const acp = !!readStoredKey();
      if (loggedIn) add('ok', 'Devin login', 'CLI authenticated');
      else if (acp) add('ok', 'Devin login', 'CLI not logged in, but the editor key is stored - dashboard runs use ACP (ff run --direct needs the CLI login)');
      else add('warn', 'Devin login', 'not logged in - no run can start', 'run: devin auth login  (or the dashboard\'s Login button)');
    }
  }

  // 7. Dashboard
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    add(r.ok ? 'ok' : 'warn', 'Dashboard', r.ok ? `running on http://127.0.0.1:${PORT}` : `port ${PORT} answers ${r.status}`, 'start it with: ff');
  } catch { add('info', 'Dashboard', `not running on port ${PORT}`, 'start it with: ff'); }
}

await check();
const wiringBroken = results.some((r) => r.status === 'fail' && /^(Locator|Link:)/.test(r.name));
if (FIX && wiringBroken) {
  if (!JSON_OUT) console.log('Repairing the Devin wiring (install.mjs)...');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'install.mjs')], { cwd: ROOT, encoding: 'utf8' });
  if (!JSON_OUT && r.status !== 0) console.log((r.stdout || '') + (r.stderr || ''));
  await check();
}

const failed = results.filter((r) => r.status === 'fail').length;
const warned = results.filter((r) => r.status === 'warn').length;
if (JSON_OUT) {
  console.log(JSON.stringify({ root: ROOT, ok: failed === 0, failed, warned, checks: results }, null, 2));
} else {
  const icon = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m', info: '\x1b[36m·\x1b[0m' };
  const width = Math.max(...results.map((r) => r.name.length)) + 2;
  console.log(`FlowForge doctor - ${ROOT}\n`);
  for (const r of results) {
    console.log(`  ${icon[r.status]} ${r.name.padEnd(width)}${r.detail}`);
    if (r.status !== 'ok' && r.fix) console.log(`    ${' '.repeat(width)}-> ${r.fix}`);
  }
  console.log(`\n  ${failed ? `${failed} problem(s)` : 'all good'}${warned ? `, ${warned} warning(s)` : ''}${failed && !FIX && wiringBroken ? ' - try: ff doctor --fix' : ''}`);
}
process.exit(failed ? 1 : 0);
