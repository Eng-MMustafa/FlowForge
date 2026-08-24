// run-checks.mjs - Run the project's build/lint/test commands and write a verdict to .workbench/artifacts/checks.md
// Command sources (first match wins):
//   1. .workbench/knowledge.json -> commands.build/.lint/.test (strings, run from project root via cmd shell)
//   2. package.json scripts (build/lint/test) via npm.cmd
// Exit code: 0 = all PASS (or SKIPPED), 1 = any FAIL.
// Usage: node run-checks.mjs "C:\path\to\project"
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = path.resolve(process.argv[2] || '.');
const TAIL = 150;

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
  for (const k of ['build', 'lint', 'test']) {
    const c = knowledge.commands[k];
    if (typeof c === 'string' && c.trim()) commands[k] = c.trim();
  }
}
if (!Object.keys(commands).length) {
  const pkg = readJson(path.join(PROJECT, 'package.json'));
  if (pkg && pkg.scripts) {
    for (const k of ['build', 'lint', 'test']) {
      if (pkg.scripts[k]) commands[k] = `npm.cmd run ${k}`;
    }
  }
}

const lines = [];
const put = (s = '') => lines.push(s);
put('# Checks (auto-generated)');
put('');
put(`- Project: ${PROJECT}`);
put(`- Generated: ${new Date().toISOString()}`);
put('');

if (!Object.keys(commands).length) {
  put('No check commands found (no knowledge.json commands, no package.json scripts).');
  put('');
  put('RESULT: SKIPPED');
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.log('RESULT: SKIPPED (no commands found)');
  process.exit(0);
}

let anyFailed = false;
for (const [name, cmd] of Object.entries(commands)) {
  put(`## ${name}`);
  put(`Command: \`${cmd}\``);
  const started = Date.now();
  const r = spawnSync(cmd, { cwd: PROJECT, shell: true, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  const secs = Math.round((Date.now() - started) / 1000);
  const exitCode = r.status === null ? 1 : r.status;
  const status = exitCode === 0 ? 'PASS' : 'FAIL';
  if (exitCode !== 0) anyFailed = true;
  put(`Status: ${status} (exit ${exitCode}, ${secs}s)`);
  put('```');
  const output = `${r.stdout || ''}${r.stderr || ''}`.split('\n');
  const tail = output.slice(-TAIL);
  put(tail.join('\n').trimEnd());
  if (output.length > TAIL) put(`... (showing last ${TAIL} of ${output.length} lines)`);
  if (r.error) put(`SPAWN ERROR: ${r.error.message}`);
  put('```');
  put('');
  console.log(`${name} -> ${status} (exit ${exitCode})`);
}

put(anyFailed ? 'RESULT: FAIL' : 'RESULT: PASS');
fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(`RESULT: ${anyFailed ? 'FAIL' : 'PASS'} (details in ${outFile})`);
process.exit(anyFailed ? 1 : 0);
