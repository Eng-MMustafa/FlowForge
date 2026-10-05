// run-checks.mjs - Run the project's build/lint/test commands and write a verdict to .workbench/artifacts/checks.md
// Command sources (first match wins):
//   1. .workbench/knowledge.json -> commands.build/.lint/.test (strings, run from project root via cmd shell)
//   2. package.json scripts (build/lint/test) via npm (npm.cmd on Windows)
// Lanes run in parallel: lint on its own, build then test in order (tests
// often need the build output). knowledge.json `"checksSequential": true`
// forces the old one-after-another order for projects that cannot overlap.
// Exit code: 0 = all PASS (or SKIPPED), 1 = any FAIL.
// Usage: node run-checks.mjs "<path to project>"
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { npmBin } from './lib/platform.mjs';

const PROJECT = path.resolve(process.argv[2] || '.');
const TAIL = 150;
const TIMEOUT_MS = 15 * 60 * 1000;
const ORDER = ['build', 'lint', 'test'];

if (!fs.existsSync(PROJECT)) { console.error(`Project not found: ${PROJECT}`); process.exit(1); }
const artifactsDir = path.join(PROJECT, '.workbench', 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });
const outFile = path.join(artifactsDir, 'checks.md');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const commands = {};
const knowledge = readJson(path.join(PROJECT, '.workbench', 'knowledge.json'));
if (knowledge && knowledge.commands) {
  for (const k of ORDER) {
    const c = knowledge.commands[k];
    if (typeof c === 'string' && c.trim()) commands[k] = c.trim();
  }
}
if (!Object.keys(commands).length) {
  const pkg = readJson(path.join(PROJECT, 'package.json'));
  if (pkg && pkg.scripts) {
    for (const k of ORDER) {
      if (pkg.scripts[k]) commands[k] = `${npmBin()} run ${k}`;
    }
  }
}
const sequential = !!(knowledge && knowledge.checksSequential);

const lines = [];
const put = (s = '') => lines.push(s);
put('# Checks (auto-generated)');
put('');
put(`- Project: ${PROJECT}`);
put(`- Generated: ${new Date().toISOString()}`);

if (!Object.keys(commands).length) {
  put('');
  put('No check commands found (no knowledge.json commands, no package.json scripts).');
  put('');
  put('RESULT: SKIPPED');
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.log('RESULT: SKIPPED (no commands found)');
  process.exit(0);
}

// One command; resolves with its result instead of throwing.
function runOne(name, cmd) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let error = null;
    const child = spawn(cmd, { cwd: PROJECT, shell: true, windowsHide: true, env: { ...process.env, CI: process.env.CI || '1' } });
    const timer = setTimeout(() => { error = new Error(`timed out after ${TIMEOUT_MS / 60000} min`); try { child.kill(); } catch {} }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { error = e; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code === null || error ? (code || 1) : code;
      const r = { name, cmd, exitCode, secs: Math.round((Date.now() - started) / 1000), output: out, error };
      console.log(`${name} -> ${exitCode === 0 ? 'PASS' : 'FAIL'} (exit ${exitCode}, ${r.secs}s)`);
      resolve(r);
    });
  });
}

// A lane runs its commands in order and stops at the first failure: a test
// run against a broken build only adds noise.
async function lane(names) {
  const results = [];
  for (const n of names) {
    if (!commands[n]) continue;
    const r = await runOne(n, commands[n]);
    results.push(r);
    if (r.exitCode !== 0) {
      for (const rest of names.slice(names.indexOf(n) + 1)) {
        if (commands[rest]) results.push({ name: rest, cmd: commands[rest], skipped: `skipped - ${n} failed` });
      }
      break;
    }
  }
  return results;
}

const started = Date.now();
const lanes = sequential ? [ORDER] : [['build', 'test'], ['lint']];
const results = (await Promise.all(lanes.map(lane))).flat();
results.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
const totalSecs = Math.round((Date.now() - started) / 1000);
put(`- Mode: ${sequential ? 'sequential' : 'parallel lanes (build -> test) || (lint)'}, wall time ${totalSecs}s`);
put('');

let anyFailed = false;
for (const r of results) {
  put(`## ${r.name}`);
  put(`Command: \`${r.cmd}\``);
  if (r.skipped) { put(`Status: SKIPPED (${r.skipped})`); put(''); continue; }
  const status = r.exitCode === 0 ? 'PASS' : 'FAIL';
  if (r.exitCode !== 0) anyFailed = true;
  put(`Status: ${status} (exit ${r.exitCode}, ${r.secs}s)`);
  put('```');
  const output = r.output.split('\n');
  put(output.slice(-TAIL).join('\n').trimEnd());
  if (output.length > TAIL) put(`... (showing last ${TAIL} of ${output.length} lines)`);
  if (r.error) put(`SPAWN ERROR: ${r.error.message}`);
  put('```');
  put('');
}

put(anyFailed ? 'RESULT: FAIL' : 'RESULT: PASS');
fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(`RESULT: ${anyFailed ? 'FAIL' : 'PASS'} in ${totalSecs}s (details in ${outFile})`);
process.exit(anyFailed ? 1 : 0);
